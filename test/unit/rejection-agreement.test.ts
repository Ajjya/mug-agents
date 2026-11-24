import { describe, expect, it } from 'vitest';
import { buildHarness } from '../support/planner-harness.js';
import { NOW, brief } from '../support/planner-fixtures.js';
import {
  InMemoryApprovalDecisionsRepository,
  InMemoryApprovalRequestsRepository,
  InMemoryEventsRepository,
  InMemoryTasksRepository,
} from '../support/in-memory.repositories.js';
import { buildSpeakersHarness, inMemorySpeakerRepos } from '../support/speakers-harness.js';
import { day, eventMessages, queueForReview, seed } from '../support/speakers-workflow-suite.js';

/**
 * One meaning of "reject", in both agents (the planner's: "a rejected plan can be planned again").
 * Stated as observable invariants and checked on each:
 *   1. nothing from the rejected proposal is applied;
 *   2. the reason stays on record, and the rejected proposal is never edited or deleted;
 *   3. the decision is final for THAT request (it cannot be decided again);
 *   4. a rejection is not a dead end: after an explicit human act the agent produces a NEW proposal,
 *      with a NEW approval request on the same thread, which is reviewed like any other.
 * The explicit act differs only because the agents are triggered differently: `plan` is always a
 * human command, so asking again is the act; `speakers run` is also scheduled work, so a rejection
 * holds that kind until a status reset or `--redraft` says a human wants another go.
 */
describe('rejection means the same in the planner and the speakers agent', () => {
  it('planner: reject, then plan again', async () => {
    const repos = {
      events: new InMemoryEventsRepository(),
      tasks: new InMemoryTasksRepository(),
      requests: new InMemoryApprovalRequestsRepository(),
      decisions: new InMemoryApprovalDecisionsRepository(),
    };
    const h = buildHarness(repos);
    const first = await h.planner.startPlan(brief(), { now: NOW });
    if (first.status !== 'awaiting_approval') throw new Error('expected a review');
    await h.approvals.decide(
      first.requestId ?? '',
      { decision: 'reject', reason: 'redo' },
      'vlad',
      NOW,
    );

    // 1. nothing applied
    expect(await repos.tasks.count()).toBe(0);
    // 2. reason on record; the rejected request is still there, decided
    expect((await repos.events.findById(first.event._id))?.notes).toContain('redo');
    expect((await repos.requests.findById(first.requestId ?? ''))?.status).toBe('decided');
    // 3. final for that request
    await expect(
      h.approvals.decide(first.requestId ?? '', { decision: 'approve' }, 'vlad', NOW),
    ).rejects.toThrow(/already decided/);
    // 4. a new proposal, a new request, same thread
    const again = await h.planner.startPlan(brief(), { now: NOW });
    expect(again.status).toBe('awaiting_approval');
    if (again.status !== 'awaiting_approval') return;
    expect(again.requestId).not.toBe(first.requestId);
    expect(again.threadId).toBe(first.threadId);
  });

  it('speakers: reject, then a status reset', async () => {
    const h = buildSpeakersHarness(inMemorySpeakerRepos());
    const s = await seed(h.repos, [
      { name: 'Wendeline Gooseberry', status: 'confirmed', contacted: true },
    ]);
    const sp = s.speakers['Wendeline Gooseberry'] ?? '';
    await queueForReview(h, s, 'Wendeline Gooseberry');
    const first = await h.service.run(s.eventId, { now: day('2026-10-31') });
    await h.approvals.decide(
      first.requestId ?? '',
      { decision: 'reject', reason: 'redo' },
      'vlad',
      day('2026-11-02'),
    );

    // 1. nothing applied: not approved, not sendable, no status change
    const [rejected] = await eventMessages(h, s.eventId);
    expect(rejected?.status).toBe('rejected');
    await expect(h.service.sent(rejected?._id ?? '', 'vlad', day('2026-11-03'))).rejects.toThrow(
      /it is rejected/,
    );
    expect(await h.store.currentStatus(sp, s.eventId)).toBe('confirmed');
    // 2. reason on record; the request is still there, decided
    expect(rejected?.rejectionReason).toBe('redo');
    expect((await h.repos.requests.findById(first.requestId ?? ''))?.status).toBe('decided');
    // 3. final for that request
    await expect(
      h.approvals.decide(first.requestId ?? '', { decision: 'approve' }, 'vlad', day('2026-11-03')),
    ).rejects.toThrow(/already decided/);
    // 4. after the human act (an explicit redraft): a new round, and the rejected one stays as it was
    const again = await h.service.run(s.eventId, {
      now: day('2026-11-16'),
      redraft: [{ speakerId: sp, kind: 'chase_abstract' }],
    });
    expect(again.created.map((m) => [m.kind, m.round])).toEqual([['chase_abstract', 2]]);
    expect(again.threadId).toBe(first.threadId);
    // and the rejected one is exactly as it was
    expect((await eventMessages(h, s.eventId))[0]).toEqual(rejected);
  });
});
