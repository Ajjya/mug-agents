import type { ThreadView } from '../agents/planner/planner.runtime.js';
import type { ApprovalDecision, ApprovalRequest } from './approval.schema.js';
import type { Listing } from './approvals.service.js';
import type { PlanReviewPayload } from './plan-review.payload.js';

/** Human-readable age: "3d 4h", "12m", "40s". */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ${String(m % 60)}m`;
  return `${String(Math.floor(h / 24))}d ${String(h % 24)}h`;
}

/** The plan a human is asked to review, readable (not a JSON dump). */
export function formatReview(review: PlanReviewPayload): string {
  const out: string[] = [`Event ${review.eventId}: ${review.theme}`, '', 'TIMELINE'];
  for (const m of review.milestones) {
    out.push(
      `  ${m.key.padEnd(7)} ${m.dateIso.slice(0, 10)}  ${m.label}${m.clamped ? '  [past: moved to today]' : ''}`,
    );
    out.push(`          goal: ${m.goal}`);
    for (const w of m.work) out.push(`          - ${w}`);
  }
  out.push('', 'PROPOSED CHECKLIST');
  for (const m of review.milestones) {
    const items = review.checklist.filter((t) => t.milestone === m.key);
    if (items.length === 0) continue;
    out.push(`  ${m.key} (${m.dateIso.slice(0, 10)})`);
    for (const t of items) out.push(`    [ ] ${t.title}  (${t.owner})`);
  }
  return out.join('\n');
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** `approvals list`: pending requests (orphans flagged) and resumable threads. */
export function formatListing(listing: Listing): string {
  const out: string[] = [];
  out.push(`PENDING APPROVALS (${String(listing.pending.length)})`);
  if (listing.pending.length === 0) out.push('  none');
  for (const row of listing.pending) {
    const r = row.request;
    const flag = row.orphan
      ? `  ORPHAN: thread is not waiting, not actionable; run "approvals resume ${r.threadId}"`
      : '';
    out.push(
      `  ${r._id}  event ${r.eventId}  ${pad(r.nodeName, 20)} age ${formatAge(row.ageMs)}${flag}`,
    );
  }
  out.push('', `RESUMABLE THREADS (${String(listing.resumable.length)})`);
  if (listing.resumable.length === 0) out.push('  none');
  for (const t of listing.resumable) {
    out.push(
      `  ${t.threadId}  stopped at ${t.failedNode ?? '?'}${t.error ? `  (${t.error})` : ''}`,
    );
    out.push(`    resume with: npm run approvals -- resume ${t.threadId}`);
  }
  if (listing.running.length > 0) {
    out.push('', `RUNNING NOW (${String(listing.running.length)})`);
    for (const t of listing.running) out.push(`  ${t.threadId}  (another process holds it)`);
  }
  return out.join('\n');
}

export function formatRequest(
  request: ApprovalRequest,
  thread: ThreadView,
  decision: ApprovalDecision | null,
): string {
  const out = [
    `Approval request ${request._id}  [${request.status}]`,
    `  kind ${request.kind}, node ${request.nodeName}`,
    `  thread ${request.threadId}  (${thread.status})`,
    `  created ${request.createdAt}`,
  ];
  if (decision) {
    const why = decision.reason ? ` ("${decision.reason}")` : '';
    out.push(
      `  decided ${decision.decidedAt} by ${decision.decidedBy}: ${decision.decision}${why}`,
    );
  }
  out.push('', formatReview(request.payload));
  return out.join('\n');
}

/** How a run ended, one line. */
export function formatThreadOutcome(thread: ThreadView): string {
  switch (thread.status) {
    case 'completed':
      return thread.outcome === 'rejected'
        ? 'Run ended: plan rejected, nothing persisted.'
        : `Run ended: plan persisted (${String(thread.persisted?.created ?? 0)} tasks created, ${String(thread.persisted?.skipped ?? 0)} already existed).`;
    case 'awaiting_decision':
      return 'Run is waiting for a decision.';
    case 'resumable':
      return `Run stopped at ${thread.failedNode ?? '?'}: resume with "approvals resume ${thread.threadId}".`;
    case 'none':
      return 'No such thread.';
  }
}
