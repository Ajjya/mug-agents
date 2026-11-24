import type { PollReport } from './inbox.service.js';

/**
 * What `inbox poll` prints. A pure function so the first real run's output is under test:
 *  - a dry run lists what it WOULD store (date, thread id, subject) for in-scope messages only;
 *  - everything else is a COUNT: nothing about a dropped message (no subject, no address, no id) is printed.
 */
/** Messages the per-message deadline stopped are reported on their own: that is time, not the schema. */
const deadlineNote = (r: PollReport): string =>
  r.triageDeadlineStopped > 0
    ? `; stopped at the per-message deadline (TRIAGE_MESSAGE_DEADLINE_MS) ${String(r.triageDeadlineStopped)}`
    : '';

export function formatPollReport(
  r: PollReport,
  options: { dryRun: boolean; label: string },
): string[] {
  const out: string[] = [];
  if (options.dryRun) {
    out.push(
      `DRY RUN: nothing stored, no body fetched, no model called.`,
      '',
      `WOULD STORE AND TRIAGE (${String(r.wouldStore.length)}), label "${options.label}":`,
    );
    for (const w of r.wouldStore) {
      out.push(
        `  ${w.receivedAt.slice(0, 10)}  thread ${w.threadId}  ${w.subject || '(no subject)'}`,
      );
    }
  } else {
    out.push(
      `Stored ${String(r.stored.length)}; already stored ${String(r.alreadyStored)}; triaged ${String(r.triaged)}; triage failed ${String(r.triageFailed)}${deadlineNote(r)}; triage pending ${String(r.triagePending)}${r.triageSkippedExcluded > 0 ? `; left alone (excluded threads) ${String(r.triageSkippedExcluded)}` : ''}.`,
    );
  }
  out.push(
    `Dropped (not in scope, nothing stored or fetched): ${String(r.dropped)}; excluded threads: ${String(r.droppedExcluded)}; new candidate threads: ${String(r.candidatesRecorded)}; own sent mail skipped: ${String(r.skippedOutbound)}.`,
    `Cursor: ${r.uidValidityReset ? 'a folder was recreated (UIDVALIDITY changed): its cursor was discarded and it was swept again' : 'by UID within each label folder'}.${r.sweepTruncated ? ' A sweep hit its page limit (GMAIL_SWEEP_MAX_PAGES): the rest is picked up by the next poll.' : ''}`,
  );
  const platform = Object.entries(r.platform).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (platform.length > 0) {
    const total = platform.reduce((n, [, c]) => n + c, 0);
    out.push(
      `Platform mail (kept, no model, no task, never linked, never pauses a chase): ${String(total)}: ${platform.map(([a, c]) => `${a} ${String(c)}`).join(', ')}.`,
    );
  }
  return out;
}

/**
 * How the triaged messages were decided, and how many reached a model. Counts only: nothing about a message.
 * `reached a model` is the number that matters for cost, time and what leaves the machine.
 */
export function formatTriageRouting(r: PollReport): string[] {
  const d = r.decidedBy;
  const n = (k: keyof typeof d): string => String(d[k]);
  const decided = Object.values(d).reduce((a, b) => a + b, 0);
  return [
    `Intent decided by (${String(decided)} message(s) triaged): List-Unsubscribe ${n('rule_list_unsubscribe')}; calendar part ${n('rule_calendar')}; document-share sender ${n('rule_sender_list')}; known speaker ${n('lookup_speaker')}; known contact ${n('lookup_contact')}; model alone ${n('model')}.`,
    `Reached a model: ${String(r.reachedModel)} of ${String(decided + r.triageFailed + r.triageDeadlineStopped)}. Rule/lookup disagreements (earlier decider won, counted not hidden): ${String(r.ruleConflicts)}. Wall-clock: ${(r.elapsedMs / 1000).toFixed(1)}s.`,
  ];
}
