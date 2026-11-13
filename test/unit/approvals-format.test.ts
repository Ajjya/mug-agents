import { describe, expect, it } from 'vitest';
import type { ThreadView } from '../../src/agents/planner/planner.runtime.js';
import {
  formatAge,
  formatListing,
  formatRequest,
  formatReview,
  formatThreadOutcome,
} from '../../src/approvals/format.js';
import { approvalRequestInput, planReviewPayload } from '../support/approval-fixtures.js';

const thread = (over: Partial<ThreadView> = {}): ThreadView => ({
  threadId: 'event:a:plan',
  status: 'awaiting_decision',
  next: [],
  calls: [],
  ...over,
});
const request = (over = {}) => ({
  ...approvalRequestInput(),
  _id: 'f'.repeat(24),
  version: 1,
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  ...over,
});

describe('formatAge', () => {
  it.each([
    [0, '0s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [3_600_000, '1h 0m'],
    [3 * 86_400_000 + 4 * 3_600_000, '3d 4h'],
    [-5, '0s'],
  ])('%i ms -> %s', (ms, text) => {
    expect(formatAge(ms)).toBe(text);
  });
});

describe('formatReview', () => {
  const text = formatReview(planReviewPayload());
  it('is readable text, not a JSON dump', () => {
    expect(text).toContain('TIMELINE');
    expect(text).toContain('PROPOSED CHECKLIST');
    expect(text).toContain('[ ] Confirm venue  (venue-lead)');
    expect(text).not.toContain('{');
    expect(text).not.toContain('"');
  });
});

describe('formatListing', () => {
  it('flags an orphan as not actionable and shows how to repair it', () => {
    const r = request();
    const text = formatListing({
      pending: [
        { request: r, thread: thread({ status: 'resumable' }), orphan: true, ageMs: 90_000 },
      ],
      resumable: [],
      running: [],
    });
    expect(text).toContain(r._id);
    expect(text).toContain('ORPHAN');
    expect(text).toContain(`approvals resume ${r.threadId}`);
    expect(text).toContain('age 1m');
  });

  it('lists an actionable request without the marker, and failed threads with the failed node', () => {
    const text = formatListing({
      pending: [{ request: request(), thread: thread(), orphan: false, ageMs: 5000 }],
      running: [],
      resumable: [
        thread({
          status: 'resumable',
          failedNode: 'generateTimeline',
          error: 'ProviderUnavailableError: HTTP 503',
        }),
      ],
    });
    expect(text).not.toContain('ORPHAN');
    expect(text).toContain('stopped at generateTimeline');
    expect(text).toContain('ProviderUnavailableError');
    expect(formatListing({ pending: [], resumable: [], running: [] })).toContain('none');
  });
});

describe('formatRequest / formatThreadOutcome', () => {
  it('shows the decision when there is one', () => {
    const text = formatRequest(request({ status: 'decided' }), thread({ status: 'completed' }), {
      _id: 'e'.repeat(24),
      version: 1,
      createdAt: '',
      updatedAt: '',
      requestId: 'f'.repeat(24),
      decision: 'reject',
      reason: 'wrong venue',
      decidedBy: 'vlad',
      decidedAt: '2026-11-10T11:00:00.000Z',
    });
    expect(text).toContain('decided 2026-11-10T11:00:00.000Z by vlad: reject ("wrong venue")');
  });

  it('says how a run ended', () => {
    expect(formatThreadOutcome(thread({ status: 'completed', outcome: 'rejected' }))).toContain(
      'rejected',
    );
    expect(
      formatThreadOutcome(
        thread({
          status: 'completed',
          outcome: 'persisted',
          persisted: { created: 5, skipped: 1 },
        }),
      ),
    ).toContain('5 tasks created, 1 already existed');
    expect(
      formatThreadOutcome(thread({ status: 'resumable', failedNode: 'persistPlan' })),
    ).toContain('approvals resume');
    expect(formatThreadOutcome(thread())).toContain('waiting');
  });
});
