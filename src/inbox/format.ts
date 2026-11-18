import type { PollReport } from './inbox.service.js';

/**
 * What `inbox poll` prints. A pure function so the first real run's output is under test:
 *  - a dry run lists what it WOULD store (date, thread id, subject) for in-scope messages only;
 *  - everything else is a COUNT: nothing about a dropped message (no subject, no address, no id) is printed.
 */
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
      `Stored ${String(r.stored.length)}; already stored ${String(r.alreadyStored)}; triaged ${String(r.triaged)}; triage failed ${String(r.triageFailed)}; triage pending ${String(r.triagePending)}${r.triageSkippedExcluded > 0 ? `; left alone (excluded threads) ${String(r.triageSkippedExcluded)}` : ''}.`,
    );
  }
  out.push(
    `Dropped (not in scope, nothing stored or fetched): ${String(r.dropped)}; excluded threads: ${String(r.droppedExcluded)}; new candidate threads: ${String(r.candidatesRecorded)}; own sent mail skipped: ${String(r.skippedOutbound)}.`,
    `History: ${r.historyExpired ? 'EXPIRED, fell back to the bounded label sweep' : r.historyUsed ? 'used' : 'no cursor yet'}.${r.sweepTruncated ? ' The label sweep hit its page limit (GMAIL_SWEEP_MAX_PAGES): older labelled mail may not have been listed.' : ''}`,
  );
  return out;
}
