import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ConfigError } from '../src/config/env.schema.js';
import { GmailTransportError } from '../src/inbox/gmail.errors.js';
import {
  GoldenNotVerifiedError,
  UntrackedPathRequiredError,
  checkGolden,
  exportGolden,
} from '../src/inbox/golden.js';
import { formatPollReport } from '../src/inbox/format.js';
import type { GmailClient } from '../src/inbox/gmail.transport.js';
import { GMAIL_CLIENT, INBOX_CONFIG, InboxModule, TRIAGER } from '../src/inbox/inbox.module.js';
import {
  InboxInputError,
  InboxLabelMissingError,
  InboxService,
} from '../src/inbox/inbox.service.js';
import {
  CONTACTS_REPOSITORY,
  EXCLUDED_THREADS_REPOSITORY,
  INBOUND_MESSAGES_REPOSITORY,
  type ContactsRepository,
  type ExcludedThreadsRepository,
  type InboundMessagesRepository,
} from '../src/inbox/repositories.js';
import type { Triager } from '../src/inbox/triage.js';
import { ProviderUnavailableError } from '../src/llm/errors.js';
import {
  ORGANISATIONS_REPOSITORY,
  type OrganisationsRepository,
} from '../src/repositories/organisations.repository.js';
import {
  SPEAKERS_REPOSITORY,
  type SpeakersRepository,
} from '../src/repositories/speakers.repository.js';
import { runCli } from './cli.js';

const USAGE = `Usage: npm run inbox -- <command> [options]

READ-ONLY. Nothing here sends, drafts or changes anything in Gmail: the label folders are only ever opened
with EXAMINE, and INBOX and [Gmail]/All Mail are never opened.

  poll [--since <date>] [--dry-run]
                                          read the mug-agents folder, store, triage, link.
                                          --dry-run prints what it WOULD store (envelopes only: no body is
                                          fetched, no model is called, nothing is written)
  candidates                              threads carrying only the loose label: subject, sender, date,
                                          thread id. Metadata only: no body is ever fetched for these
  admit <threadId> [--by <name>]          let the system read a candidate thread (bodies, triage, links)
  dismiss <threadId> [--reason "..."]     refuse a candidate's loose label for good (undo: undismiss <threadId>);
                                          labelling it mug-agents later still admits it: exclude-thread is the hard stop
  exclude-thread <threadId> --reason "..." stop reading a thread, even if labelled (until: include-thread)
  include-thread <threadId>               lift an exclusion
  list [--limit n]                        stored messages: id, date, sender, triage, link
  show <messageId> [--raw]                one message and its summary; --raw prints the stored body
  link <messageId> --speaker <id> --event <id>
                                          link a message to a speaker and event (pauses chasing)
  retry-triage <messageId>                run triage again for a message whose triage failed
  export-golden --out <dir> [--mapping <file>] [--limit n]
                                          anonymised bodies + the model's proposed labels, all "unverified"
  check-golden <dir>                      how many golden fields are still unverified (the eval refuses them)

Required in .env for everything except check-golden: GMAIL_LABEL and GMAIL_CANDIDATE_LABEL (distinct).
IMAP_USER and IMAP_APP_PASSWORD (a Gmail app password) are needed only by commands that talk to Gmail (poll).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    since: { type: 'string' },
    'dry-run': { type: 'boolean' },
    by: { type: 'string' },
    reason: { type: 'string' },
    limit: { type: 'string' },
    raw: { type: 'boolean' },
    speaker: { type: 'string' },
    event: { type: 'string' },
    out: { type: 'string' },
    mapping: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const [command, target] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
const usage = (): number => {
  console.error(USAGE);
  return 2;
};

/** check-golden needs no database, no labels and no Gmail. */
function runCheckGolden(dir: string): number {
  const c = checkGolden(dir);
  console.log(`${String(c.files)} golden file(s) in ${dir}`);
  for (const p of c.problems) console.log(`  INVALID  ${p}`);
  for (const f of c.perFile.filter((x) => x.unverified.length > 0)) {
    console.log(`  unverified  ${f.name}: ${f.unverified.join(', ')}`);
  }
  console.log(`\nUnverified fields: ${String(c.unverified)}`);
  console.log(
    `Messages per intent: ${
      Object.entries(c.intentCounts)
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(', ') || 'none'
    }`,
  );
  if (c.majority) {
    console.log(
      `Majority-class baseline for intent: ${(c.majority.share * 100).toFixed(0)}% (${c.majority.intent}): any intent accuracy is read against it.`,
    );
    console.log(
      `With ${String(c.files)} messages, one case is ${((1 / c.files) * 100).toFixed(0)}% of a score.`,
    );
  }
  console.log(
    c.ok
      ? '\nOK: the set is fully verified and the eval will run on it.'
      : '\nNOT evaluable: correct the files and mark every field "verified".',
  );
  return c.ok ? 0 : 1;
}

const handle = (err: unknown): number | undefined => {
  if (err instanceof InboxLabelMissingError || err instanceof InboxInputError) {
    console.error(err.message);
    return 2;
  }
  if (err instanceof GoldenNotVerifiedError || err instanceof UntrackedPathRequiredError) {
    console.error(err.message);
    return 2;
  }
  if (err instanceof z.ZodError) {
    console.error(`Invalid input:\n${z.prettifyError(err)}`);
    return 2;
  }
  if (err instanceof ConfigError) {
    console.error(err.message);
    return 1;
  }
  if (err instanceof GmailTransportError) {
    console.error(err.message);
    return 3;
  }
  if (err instanceof ProviderUnavailableError) {
    console.error(`PROVIDER FAILURE (not a model failure): ${err.message}`);
    return 3;
  }
  return undefined;
};

if (command === 'check-golden') {
  if (!target) process.exit(usage());
  process.exit(runCheckGolden(target));
}
runCli(
  async (app, config) => {
    const inbox = app.get(InboxService, { strict: false });
    const by = values.by ?? config.APPROVER_NAME ?? userInfo().username;
    switch (command) {
      case 'poll': {
        const label = app.get<{ label: string; candidateLabel: string }>(INBOX_CONFIG, {
          strict: false,
        });
        const r = await inbox
          .poll({
            ...(values.since ? { since: values.since } : {}),
            dryRun: values['dry-run'] === true,
          })
          .finally(() => app.get<GmailClient>(GMAIL_CLIENT, { strict: false }).close());
        for (const line of formatPollReport(r, {
          dryRun: values['dry-run'] === true,
          label: label.label,
        })) {
          console.log(line);
        }
        return 0;
      }
      case 'candidates': {
        const rows = await inbox.listCandidates();
        if (rows.length === 0) {
          console.log('No candidate threads waiting.');
          return 0;
        }
        console.log('Candidate threads (metadata only; the system has read no body):\n');
        for (const c of rows) {
          console.log(
            `  ${c.threadId}  ${c.lastSeenAt.slice(0, 10)}  ${c.from.address}  ${c.subject || '(no subject)'}`,
          );
        }
        console.log(
          '\nadmit <threadId> lets the system read it; dismiss <threadId> refuses it for good.',
        );
        return 0;
      }
      case 'admit': {
        if (!target) return usage();
        await inbox.admit(target, by);
        console.log(`Admitted ${target}. The next poll reads its messages.`);
        return 0;
      }
      case 'dismiss': {
        if (!target) return usage();
        await inbox.dismiss(target, values.reason);
        console.log(
          `Dismissed ${target}: it will not be listed or read again (undo: undismiss ${target}).`,
        );
        return 0;
      }
      case 'undismiss': {
        if (!target) return usage();
        await inbox.undismiss(target);
        console.log(`${target} is a pending candidate again.`);
        return 0;
      }
      case 'exclude-thread': {
        if (!target || !values.reason) return usage();
        await inbox.excludeThread(target, values.reason);
        console.log(
          `Excluded ${target}: nothing further from it is fetched, stored or triaged (undo: include-thread ${target}).`,
        );
        return 0;
      }
      case 'include-thread': {
        if (!target) return usage();
        await inbox.includeThread(target);
        console.log(`Lifted the exclusion on ${target}.`);
        return 0;
      }
      case 'list': {
        const rows = await inbox.listMessages(Number(values.limit ?? 30));
        for (const m of rows) {
          const t = m.triage
            ? `${m.triage.intent}/${m.triage.sentiment_decision}${m.triage.needs_human ? ' NEEDS-HUMAN' : ''}`
            : `triage ${m.triageState}`;
          console.log(
            `${m._id}  ${m.receivedAt.slice(0, 10)}  ${m.from.address}  ${t}  [${m.linkState}]`,
          );
        }
        if (rows.length === 0) console.log('No stored messages.');
        return 0;
      }
      case 'show': {
        if (!target) return usage();
        const m = await inbox.showMessage(target);
        if (!m) {
          console.error(`No inbound message ${target}`);
          return 2;
        }
        console.log(
          `Message ${m._id}  gmail ${m.gmailId}  thread ${m.threadId}\n  from ${m.from.name ?? ''} <${m.from.address}>\n  received ${m.receivedAt}  link: ${m.linkState}${m.linkedSpeakerId ? ` speaker ${m.linkedSpeakerId}` : ''}${m.linkedEventId ? ` event ${m.linkedEventId}` : ''}\n  subject: ${m.subject}`,
        );
        console.log(
          `  attachments: ${m.attachments.map((a) => `${a.filename} (${a.mimeType}, ${String(a.sizeBytes)} B)`).join('; ') || 'none'}`,
        );
        console.log(`\nTriage (${m.triageState}):`);
        console.log(
          m.triage
            ? JSON.stringify(m.triage, null, 2)
            : m.triageFailure
              ? `  failed: ${m.triageFailure.join('; ')}`
              : '  pending',
        );
        if (values.raw) {
          console.log(
            `\n----- RAW BODY (stored; never sent to a model) -----\n${(await inbox.getRawBody(m._id)) ?? ''}\n----- END -----`,
          );
        } else {
          console.log('\n(--raw prints the stored body)');
        }
        return 0;
      }
      case 'link': {
        if (!target || !values.speaker || !values.event) return usage();
        const m = await inbox.link(target, values.speaker, values.event);
        console.log(
          `Linked ${m._id} to speaker ${values.speaker} for event ${values.event} (confirmed by you). Chasing for that speaker and event is paused until you act.`,
        );
        return 0;
      }
      case 'retry-triage': {
        if (!target) return usage();
        const m = await inbox.retryTriage(target);
        console.log(`Triage is now: ${m.triageState}`);
        return 0;
      }
      case 'export-golden': {
        if (!values.out) return usage();
        const r = await exportGolden(
          {
            inbound: app.get<InboundMessagesRepository>(INBOUND_MESSAGES_REPOSITORY, {
              strict: false,
            }),
            speakers: app.get<SpeakersRepository>(SPEAKERS_REPOSITORY, { strict: false }),
            organisations: app.get<OrganisationsRepository>(ORGANISATIONS_REPOSITORY, {
              strict: false,
            }),
            contacts: app.get<ContactsRepository>(CONTACTS_REPOSITORY, { strict: false }),
            excluded: app.get<ExcludedThreadsRepository>(EXCLUDED_THREADS_REPOSITORY, {
              strict: false,
            }),
            triager: app.get<Triager>(TRIAGER, { strict: false }),
          },
          {
            outDir: values.out,
            ...(values.mapping ? { mappingPath: values.mapping } : {}),
            ...(values.limit ? { limit: Number(values.limit) } : {}),
          },
        );
        console.log(
          `Wrote ${String(r.written.length)} golden file(s) to ${values.out}; already exported ${String(r.skippedAlreadyExported)}; left alone (exist) ${String(r.skippedExisting)}; skipped (excluded threads) ${String(r.skippedExcluded)}.`,
        );
        console.log(
          `Every label is "unverified". Correct the files, mark each field "verified", then: npm run inbox -- check-golden ${values.out}`,
        );
        console.log(
          'The pseudonym mapping holds the real names: keep it out of git (it is written next to the files by default).',
        );
        return 0;
      }
    }
    return usage();
  },
  handle,
  [InboxModule],
);
