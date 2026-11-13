import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PlanRunInterruptedError } from '../../src/agents/planner/planner.service.js';
import { PastEventDateError, computeMilestones } from '../../src/agents/planner/timeline.js';
import {
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  ApprovalOrphanError,
} from '../../src/approvals/approvals.service.js';
import {
  InvalidEditError,
  type PlanReviewPayload,
} from '../../src/approvals/plan-review.payload.js';
import {
  SimulatedCrash,
  buildHarness,
  type Harness,
  type HarnessOptions,
  type Repos,
} from './planner-harness.js';
import { NOW, brief } from './planner-fixtures.js';

type Awaiting = Extract<
  Awaited<ReturnType<Harness['planner']['startPlan']>>,
  { status: 'awaiting_approval' }
>;

/**
 * The approval workflow end to end, with a deterministic stub model. One suite, two backends:
 * in-memory fakes + MemorySaver (unit) and MongoDB + the Mongo checkpointer (integration).
 */
export function plannerWorkflowSuite(
  create: () => Promise<{ repos: Repos } & HarnessOptions>,
): void {
  describe('planner approval workflow (stubbed model)', () => {
    let h: Harness;
    beforeEach(async () => {
      const { repos, ...options } = await create();
      h = buildHarness(repos, options);
    });

    const plan = (over: Parameters<typeof brief>[0] = {}) =>
      h.planner.startPlan(brief(over), { now: NOW });
    const awaiting = async (): Promise<Awaiting> => {
      const r = await plan();
      if (r.status !== 'awaiting_approval')
        throw new Error(`expected awaiting_approval, got ${r.status}`);
      return r;
    };
    const edited = (a: Awaiting): PlanReviewPayload => {
      const p = structuredClone(a.review);
      if (!p) throw new Error('no review payload');
      p.checklist = [{ milestone: 'T-8w', title: 'The human-edited task', owner: 'organiser' }];
      return p;
    };

    describe('suspending', () => {
      it('suspends at requestPlanApproval, writes a pending request, and persists no tasks', async () => {
        const r = await awaiting();
        expect(r.alreadyWaiting).toBe(false);
        expect(r.requestId).toBeDefined();
        expect(h.modelCalls).toEqual(['generateTimeline', 'generateChecklist']);
        expect(await h.repos.tasks.count()).toBe(0);
        const view = await h.runtime.inspect(r.threadId);
        expect(view).toMatchObject({ status: 'awaiting_decision', next: ['requestPlanApproval'] });
        const pending = (await h.repos.requests.findByStatus('pending')).items;
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          _id: r.requestId,
          kind: 'plan_review',
          nodeName: 'requestPlanApproval',
          threadId: r.threadId,
        });
        expect(pending[0]?.payload.checklist).toHaveLength(5);
        // the event exists in phase planning: the thread's anchor
        expect(r.event.phase).toBe('planning');
      });

      it('the interrupt payload is the typed contract and nothing else', async () => {
        const r = await awaiting();
        expect(Object.keys(r.review ?? {}).sort()).toEqual([
          'checklist',
          'eventId',
          'milestones',
          'theme',
        ]);
      });

      it('a second plan call while waiting continues that thread: no model call, no second request', async () => {
        const first = await awaiting();
        const callsBefore = h.modelCalls.length;
        const second = await awaiting();
        expect(second.alreadyWaiting).toBe(true);
        expect(second.threadId).toBe(first.threadId);
        expect(second.requestId).toBe(first.requestId);
        expect(h.modelCalls.length).toBe(callsBefore);
        expect(await h.repos.requests.count()).toBe(1);
        expect(await h.repos.events.count()).toBe(1);
      });

      it('rejects a past date and an invalid brief before any model call or write', async () => {
        await expect(plan({ date: '2026-11-09T00:00:00.000Z' })).rejects.toBeInstanceOf(
          PastEventDateError,
        );
        await expect(h.planner.startPlan({ theme: '' })).rejects.toThrow(/Invalid event brief/);
        expect(h.modelCalls).toEqual([]);
        expect(await h.repos.events.count()).toBe(0);
        expect(await h.repos.requests.count()).toBe(0);
      });
    });

    describe('decisions', () => {
      it('approve resumes and persists the original plan, due dates from the milestones', async () => {
        const a = await awaiting();
        const out = await h.approvals.decide(
          a.requestId ?? '',
          { decision: 'approve' },
          'vlad',
          NOW,
        );
        expect(out.thread).toMatchObject({
          status: 'completed',
          outcome: 'persisted',
          persisted: { created: 5, skipped: 0 },
        });
        const tasks = (await h.repos.tasks.findByEventId(a.event._id)).items;
        expect(tasks.map((t) => t.title).sort()).toEqual([
          'Confirm venue',
          'Draft call for speakers',
          'Publish the Meetup page',
          'Send thank-you note',
          'Set up registration desk',
        ]);
        expect(tasks.find((t) => t.title === 'Confirm venue')).toMatchObject({
          source: 'agent',
          status: 'open',
          milestoneKey: 'T-8w',
          dueAt: '2026-11-17T00:00:00.000Z',
        });
        expect(out.request.status).toBe('decided');
        expect(out.decision).toMatchObject({
          decision: 'approve',
          decidedBy: 'vlad',
          requestId: a.requestId,
        });
        expect(h.modelCalls).toEqual(['generateTimeline', 'generateChecklist']); // resuming never re-asks the model
      });

      it('edit resumes and persists the EDITED plan, not the original', async () => {
        const a = await awaiting();
        const out = await h.approvals.decide(
          a.requestId ?? '',
          { decision: 'edit', editedPayload: edited(a) },
          'vlad',
          NOW,
        );
        expect(out.thread).toMatchObject({
          status: 'completed',
          outcome: 'persisted',
          persisted: { created: 1 },
        });
        const tasks = (await h.repos.tasks.findByEventId(a.event._id)).items;
        expect(tasks.map((t) => t.title)).toEqual(['The human-edited task']);
        expect(out.decision.editedPayload?.checklist[0]?.title).toBe('The human-edited task');
      });

      it('reject persists no tasks, records the reason on the event, and leaves the phase at planning', async () => {
        const a = await awaiting();
        const out = await h.approvals.decide(
          a.requestId ?? '',
          { decision: 'reject', reason: 'wrong venue' },
          'vlad',
          NOW,
        );
        expect(out.thread).toMatchObject({ status: 'completed', outcome: 'rejected' });
        expect(await h.repos.tasks.count()).toBe(0);
        const event = await h.repos.events.findById(a.event._id);
        expect(event?.phase).toBe('planning');
        expect(event?.notes).toContain('Plan rejected: wrong venue');
        expect(out.decision).toMatchObject({ decision: 'reject', reason: 'wrong venue' });
        expect(out.request.status).toBe('decided');
      });

      it('deciding the same request twice fails and changes nothing', async () => {
        const a = await awaiting();
        await h.approvals.decide(a.requestId ?? '', { decision: 'approve' }, 'vlad', NOW);
        const tasksAfter = await h.repos.tasks.count();
        for (const value of [
          { decision: 'approve' },
          { decision: 'reject', reason: 'changed my mind' },
        ] as const) {
          await expect(
            h.approvals.decide(a.requestId ?? '', value, 'vlad', NOW),
          ).rejects.toBeInstanceOf(ApprovalNotPendingError);
        }
        expect(await h.repos.tasks.count()).toBe(tasksAfter);
        expect(await h.repos.decisions.count()).toBe(1);
      });

      it('an invalid editedPayload is refused before the graph resumes, and the thread keeps waiting', async () => {
        const a = await awaiting();
        const base = edited(a);
        const withNewDate = structuredClone(base);
        const m = withNewDate.milestones[0];
        if (!m) throw new Error('fixture');
        m.dateIso = '2030-01-01T00:00:00.000Z';
        const invalid = [
          { ...base, checklist: [] }, // fails the payload schema
          { ...base, extra: 'x' }, // unknown key
          withNewDate, // dates are computed in code
        ];
        for (const editedPayload of invalid) {
          const err = await h.approvals
            .decide(a.requestId ?? '', { decision: 'edit', editedPayload }, 'vlad', NOW)
            .catch((e: unknown) => e);
          expect(err instanceof z.ZodError || err instanceof InvalidEditError).toBe(true);
        }
        expect(await h.repos.decisions.count()).toBe(0);
        expect((await h.repos.requests.findById(a.requestId ?? ''))?.status).toBe('pending');
        expect(await h.runtime.inspect(a.threadId)).toMatchObject({ status: 'awaiting_decision' });
        expect(await h.repos.tasks.count()).toBe(0);
        // and a valid decision still works afterwards
        const ok = await h.approvals.decide(
          a.requestId ?? '',
          { decision: 'approve' },
          'vlad',
          NOW,
        );
        expect(ok.thread.outcome).toBe('persisted');
      });

      it('rejects a boolean, a reasonless reject and an unknown request id', async () => {
        const a = await awaiting();
        await expect(
          h.approvals.decide(a.requestId ?? '', true as never, 'v', NOW),
        ).rejects.toBeInstanceOf(z.ZodError);
        await expect(
          h.approvals.decide(a.requestId ?? '', { decision: 'reject' } as never, 'v', NOW),
        ).rejects.toBeInstanceOf(z.ZodError);
        await expect(
          h.approvals.decide('f'.repeat(24), { decision: 'approve' }, 'v', NOW),
        ).rejects.toBeInstanceOf(ApprovalNotFoundError);
        expect(await h.repos.decisions.count()).toBe(0);
      });
    });

    describe('idempotency on resume and re-plan', () => {
      it('resuming the same thread twice creates no duplicate tasks', async () => {
        const a = await awaiting();
        await h.approvals.decide(a.requestId ?? '', { decision: 'approve' }, 'vlad', NOW);
        const count = await h.repos.tasks.count();
        const again = await h.approvals.resumeThread(a.threadId);
        expect(again.status).toBe('already_completed');
        expect(await h.repos.tasks.count()).toBe(count);
        // the persistence step itself is a no-op the second time
        const persistedTwice = await h.persistence.insertTasks(
          a.event._id,
          { tasks: (a.review?.checklist ?? []).map((t) => ({ ...t })) },
          computeMilestones(brief().date, NOW),
        );
        expect(persistedTwice.created).toHaveLength(0);
        expect(await h.repos.tasks.count()).toBe(count);
      });

      it('after approval, planning the same event again is already_planned and calls no model', async () => {
        const a = await awaiting();
        await h.approvals.decide(a.requestId ?? '', { decision: 'approve' }, 'vlad', NOW);
        const calls = h.modelCalls.length;
        const r = await plan();
        expect(r).toMatchObject({ status: 'already_planned', existingTasks: 5 });
        expect(h.modelCalls.length).toBe(calls);
      });

      it('replan on a finished thread runs again on the SAME thread and adds only new titles', async () => {
        const a = await awaiting();
        await h.approvals.decide(a.requestId ?? '', { decision: 'approve' }, 'vlad', NOW);
        const r = await h.planner.startPlan(brief(), { now: NOW, replan: true });
        expect(r.status).toBe('awaiting_approval');
        if (r.status !== 'awaiting_approval') return;
        expect(r.threadId).toBe(a.threadId);
        expect(r.requestId).not.toBe(a.requestId);
        const out = await h.approvals.decide(
          r.requestId ?? '',
          { decision: 'approve' },
          'vlad',
          NOW,
        );
        expect(out.thread.persisted).toEqual({ created: 0, skipped: 5 });
        expect(await h.repos.tasks.count()).toBe(5);
      });

      it('a rejected plan can be planned again', async () => {
        const a = await awaiting();
        await h.approvals.decide(
          a.requestId ?? '',
          { decision: 'reject', reason: 'redo' },
          'vlad',
          NOW,
        );
        const r = await plan();
        expect(r.status).toBe('awaiting_approval');
      });

      it('a finished thread is stamped for expiry; a waiting one is not', async () => {
        const a = await awaiting();
        const retention = h.retention as unknown as { stamped?: string[] };
        if (!retention.stamped) return; // real retention (integration) is covered in checkpointer.test.ts
        expect(retention.stamped).toEqual([]);
        await h.approvals.decide(a.requestId ?? '', { decision: 'approve' }, 'vlad', NOW);
        expect(retention.stamped).toEqual([a.threadId]);
      });
    });

    describe('provider failure is resumable', () => {
      it('a provider failure leaves a resumable thread, shown with the node that failed; nothing half-written', async () => {
        h.behaviour.failNode = 'generateTimeline';
        const err = await plan().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PlanRunInterruptedError);
        const interrupted = err as PlanRunInterruptedError;
        expect(interrupted.message).toContain('Provider failure');
        expect(interrupted.message).toContain('approvals -- resume');
        expect(await h.repos.tasks.count()).toBe(0);
        expect(await h.repos.requests.count()).toBe(0);

        const view = await h.runtime.inspect(interrupted.threadId);
        expect(view).toMatchObject({ status: 'resumable', failedNode: 'generateTimeline' });
        expect(view.error).toContain('ProviderUnavailableError');
        expect(view.error).not.toMatch(/key|bearer/i);
      });

      it('resuming re-runs ONLY the failed node: milestones are not recomputed, no duplicates', async () => {
        h.behaviour.failNode = 'generateTimeline';
        const err = (await plan().catch((e: unknown) => e)) as PlanRunInterruptedError;
        const before = await h.runtime.inspect(err.threadId);
        h.behaviour.failNode = undefined;

        const resumed = await h.approvals.resumeThread(err.threadId);
        expect(resumed.status).toBe('resumed');
        // normaliseBrief did not run again: same run identity, same computed milestones
        expect(resumed.status === 'resumed' ? resumed.thread.runId : undefined).toBe(before.runId);
        // the failed node ran twice (fail + success), the one after it once, nothing earlier again
        expect(h.modelCalls).toEqual(['generateTimeline', 'generateTimeline', 'generateChecklist']);
        expect(resumed.status === 'resumed' ? resumed.thread.status : '').toBe('awaiting_decision');
        expect(await h.repos.requests.count()).toBe(1);
        expect(await h.repos.tasks.count()).toBe(0);
      });

      it('plan on a stopped thread continues it instead of starting over', async () => {
        h.behaviour.failNode = 'generateChecklist';
        await expect(plan()).rejects.toBeInstanceOf(PlanRunInterruptedError);
        h.behaviour.failNode = undefined;
        const r = await plan();
        expect(r.status).toBe('awaiting_approval');
        // the timeline step had completed before the failure and was not asked for again
        expect(h.modelCalls).toEqual([
          'generateTimeline',
          'generateChecklist',
          'generateChecklist',
        ]);
      });

      it('approvals list shows a failed thread as resumable with the failed node', async () => {
        h.behaviour.failNode = 'generateChecklist';
        const err = (await plan().catch((e: unknown) => e)) as PlanRunInterruptedError;
        const listing = await h.approvals.list(NOW);
        expect(listing.pending).toEqual([]);
        expect(listing.resumable.map((t) => [t.threadId, t.failedNode])).toEqual([
          [err.threadId, 'generateChecklist'],
        ]);
      });
    });

    describe('orphaned approval requests', () => {
      it('a crash between the request write and the suspend leaves a flagged, non-actionable orphan', async () => {
        h.behaviour.crashAfterRequest = true;
        await expect(plan()).rejects.toBeInstanceOf(SimulatedCrash);
        expect(await h.repos.requests.count()).toBe(1); // written before interrupt()

        const listing = await h.approvals.list(NOW);
        expect(listing.pending).toHaveLength(1);
        expect(listing.pending[0]?.orphan).toBe(true);
        const request = listing.pending[0]?.request;
        if (!request) throw new Error('no request');
        await expect(
          h.approvals.decide(request._id, { decision: 'approve' }, 'vlad', NOW),
        ).rejects.toBeInstanceOf(ApprovalOrphanError);
        expect(await h.repos.decisions.count()).toBe(0);
      });

      it('resuming an orphan thread re-runs the node, which reuses its request and suspends', async () => {
        h.behaviour.crashAfterRequest = true;
        const err = await plan().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SimulatedCrash);
        const threadId = (await h.repos.requests.findMany()).items[0]?.threadId ?? '';
        h.behaviour.crashAfterRequest = false;

        const r = await h.approvals.resumeThread(threadId);
        expect(r.status).toBe('resumed');
        expect(await h.repos.requests.count()).toBe(1); // reused, not duplicated
        const listing = await h.approvals.list(NOW);
        expect(listing.pending[0]?.orphan).toBe(false);
        const out = await h.approvals.decide(
          listing.pending[0]?.request._id ?? '',
          { decision: 'approve' },
          'vlad',
          NOW,
        );
        expect(out.thread.outcome).toBe('persisted');
      });

      it('a pending request whose thread has no checkpoint at all is an orphan; resuming expires it (never deletes)', async () => {
        const request = await h.repos.requests.insert({
          threadId: `event:${'c'.repeat(24)}:plan`,
          runId: 'lost-run',
          nodeName: 'requestPlanApproval',
          eventId: 'c'.repeat(24),
          kind: 'plan_review',
          payload: (await awaiting()).review as PlanReviewPayload,
          status: 'pending',
        });
        const listing = await h.approvals.list(NOW);
        expect(listing.pending.find((p) => p.request._id === request._id)?.orphan).toBe(true);
        const out = await h.approvals.resumeThread(request.threadId);
        expect(out).toMatchObject({ status: 'no_checkpoint', expired: 1 });
        expect((await h.repos.requests.findById(request._id))?.status).toBe('expired');
      });
    });
  });
}
