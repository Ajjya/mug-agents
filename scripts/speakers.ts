import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { EventNotFoundError } from '../src/agents/planner/plan-persistence.js';
import {
  SpeakersRunInterruptedError,
  SpeakersService,
} from '../src/agents/speakers/speakers.service.js';
import {
  MessageNotFoundError,
  MessageNotSendableError,
  SpeakerNotInEventError,
} from '../src/agents/speakers/speakers.store.js';
import { IllegalTransitionError } from '../src/agents/speakers/transitions.js';
import { SPEAKER_STATUSES } from '../src/domain/speaker.schema.js';
import { EmbeddingMismatchError, EmbeddingUnavailableError } from '../src/retrieval/embedder.js';
import { SpeakerSuggester } from '../src/retrieval/suggest-speakers.js';
import { runCli } from './cli.js';

const USAGE = `Usage: npm run speakers -- <command> [options]

  run --event <id> [--now <ISO>]       run the pipeline: print planned actions and the drafts written
  list --event <id> [--now <ISO>]      pipeline table: speaker, status, last sent, next action
  show <messageId>                     one draft, readable (copy it out from here)
  sent <messageId> [--by <name>]       record that you sent it; chases are measured from now
  status <speakerId> --event <id> --set <status>
                                       record what happened (checked against the transition table)
  candidates --event <id> --topic "..." speakers who could talk on a topic (M3's suggestSpeakers)

Only "run" can call a model. Nothing is ever sent by this tool: you copy a draft out and send it
yourself, then say so with "sent". Approvals go through: npm run approvals -- list`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    event: { type: 'string' },
    set: { type: 'string' },
    by: { type: 'string' },
    topic: { type: 'string' },
    now: { type: 'string' },
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
const now = values.now ? new Date(values.now) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error(`--now must be an ISO date, got "${values.now ?? ''}"`);
  process.exit(2);
}

runCli(
  async (app, config) => {
    const service = app.get(SpeakersService, { strict: false });
    switch (command) {
      case 'run': {
        if (!values.event) return usage();
        const r = await service.run(values.event, { now });
        if (r.alreadyWaiting) {
          console.log(
            `A run for this event is already waiting for approval (request ${r.requestId ?? '?'}). No new run started.\n` +
              'Decide with: npm run approvals -- show <id>',
          );
          return 0;
        }
        const d = r.decision;
        console.log(`PLANNED (${String(d?.actions.length ?? 0)})`);
        for (const a of d?.actions ?? []) {
          console.log(`  ${a.speakerId}  ${a.kind} #${String(a.round)}  ${a.reason}`);
        }
        if (d && d.blocked.length > 0) {
          console.log(
            `\nAT THE CHASE LIMIT (${String(d.blocked.length)}): a task each, no message`,
          );
          for (const b of d.blocked) console.log(`  ${b.speakerId}  ${b.kind}  ${b.reason}`);
        }
        for (const note of d?.notes ?? []) console.log(`\nNote: ${note}`);
        console.log(`\nDRAFTS WRITTEN (${String(r.created.length)})`);
        for (const m of r.created) {
          console.log(
            `  ${m._id}  ${m.kind} #${String(m.round)}  ${m.needsApproval ? 'needs approval' : 'draft'}  "${m.subject}"`,
          );
        }
        if (r.existing > 0)
          console.log(`  (${String(r.existing)} already existed: not written again)`);
        if (r.tasksCreated > 0) console.log(`Tasks created: ${String(r.tasksCreated)}`);
        if (r.superseded > 0) console.log(`Drafts superseded: ${String(r.superseded)}`);
        if (r.status === 'awaiting_approval') {
          console.log(`\nWaiting for approval: npm run approvals -- show ${r.requestId ?? '<id>'}`);
        }
        console.log(`Model calls: ${String(r.calls.length)}`);
        return 0;
      }
      case 'list': {
        if (!values.event) return usage();
        const { rows, notes } = await service.list(values.event, now);
        const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
        console.log(`${pad('SPEAKER', 28)}${pad('STATUS', 19)}${pad('LAST SENT', 28)}NEXT`);
        for (const r of rows) {
          const last = r.lastSent ? `${r.lastSent.kind} ${r.lastSent.at.slice(0, 10)}` : '-';
          console.log(`${pad(r.name, 28)}${pad(r.status, 19)}${pad(last, 28)}${r.next}`);
        }
        for (const n of notes) console.log(`\nNote: ${n}`);
        console.log(
          '\nThe pipeline is only as current as what it has been told: nothing reads replies yet.',
        );
        return 0;
      }
      case 'show': {
        if (!target) return usage();
        const { message: m, speakerName, email } = await service.show(target);
        console.log(
          `Message ${m._id}  [${m.status}]${m.needsApproval ? '  (first contact: needs approval)' : ''}`,
        );
        console.log(`  to ${speakerName}${email ? ` <${email}>` : ''}`);
        console.log(`  ${m.kind} round ${String(m.round)}; ${m.reason}`);
        if (m.sentAt) console.log(`  sent ${m.sentAt} by ${m.sentBy ?? '?'}`);
        if (m.rejectionReason) console.log(`  rejected: ${m.rejectionReason}`);
        console.log(`\nSubject: ${m.subject}\n\n${m.body}\n`);
        console.log('Facts (from the event record):');
        for (const [k, v] of Object.entries(m.facts)) console.log(`  ${k}: ${v}`);
        return 0;
      }
      case 'sent': {
        if (!target) return usage();
        const by = values.by ?? config.APPROVER_NAME ?? userInfo().username;
        const m = await service.sent(target, by, now);
        console.log(`Recorded: ${m.kind} ${m._id} sent ${m.sentAt ?? ''} by ${m.sentBy ?? by}.`);
        return 0;
      }
      case 'status': {
        if (!target || !values.event || !values.set) return usage();
        const to = z.enum(SPEAKER_STATUSES).parse(values.set);
        const r = await service.setStatus(target, values.event, to, now);
        console.log(`Speaker ${target}: ${r.from} -> ${r.to}`);
        return 0;
      }
      case 'candidates': {
        if (!values.topic) return usage();
        const r = await app.get(SpeakerSuggester, { strict: false }).suggest(values.topic);
        if (r.suggestions.length === 0) {
          console.log(r.message ?? `Nothing in the corpus matches "${values.topic}".`);
          return 0;
        }
        for (const s of r.suggestions) {
          console.log(`${s.speaker.name} (${s.speaker.id})\n  ${s.reason}`);
          for (const c of s.citations) console.log(`  cites ${c.id}`);
        }
        return 0;
      }
    }
    return usage();
  },
  (err) => {
    if (
      err instanceof EventNotFoundError ||
      err instanceof MessageNotFoundError ||
      err instanceof MessageNotSendableError ||
      err instanceof SpeakerNotInEventError ||
      err instanceof IllegalTransitionError ||
      err instanceof EmbeddingUnavailableError ||
      err instanceof EmbeddingMismatchError
    ) {
      console.error(err.message);
      return 2;
    }
    if (err instanceof z.ZodError) {
      console.error(`Invalid input:\n${z.prettifyError(err)}`);
      return 2;
    }
    if (err instanceof SpeakersRunInterruptedError) {
      console.error(err.message);
      return err.message.startsWith('Provider') ? 3 : 4;
    }
    return undefined;
  },
);
