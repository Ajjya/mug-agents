import {
  DECIDED_BY,
  type CandidateThread,
  type ContactRole,
  type DecidedBy,
  type FolderCursor,
  type InboundMessage,
  type InboundMessageInput,
  type InboxCursor,
} from '../domain/inbox.schema.js';
import { ProviderUnavailableError } from '../llm/errors.js';
import { DuplicateKeyError } from '../repositories/base.repository.js';
import type { EventsRepository } from '../repositories/events.repository.js';
import type { OrganisationsRepository } from '../repositories/organisations.repository.js';
import type { SpeakersRepository } from '../repositories/speakers.repository.js';
import type { TasksRepository } from '../repositories/tasks.repository.js';
import { allPages } from '../agents/planner/plan-persistence.js';
import { UNKNOWN_SENDER, parseAddress, parseAddressList } from './address.js';
import { observeCandidateRefs, recordCandidate } from './candidates.js';
import type { GmailClient, GmailMetadata, MessageRef } from './gmail.transport.js';
import type { InboxConfig } from './inbox.config.js';
import { recordInbound, resolveLink } from './linking.js';
import { redactForTriage } from './redact.js';
import { classify, ruleSummary, type Classification } from './rules.js';
import type {
  AdmittedThreadsRepository,
  CandidateThreadsRepository,
  ContactsRepository,
  ExcludedThreadsRepository,
  InboundMessagesRepository,
  InboxCursorRepository,
} from './repositories.js';
import type { Triager } from './triage.js';

export interface InboxDeps {
  gmail: GmailClient;
  inbound: InboundMessagesRepository;
  admitted: AdmittedThreadsRepository;
  excluded: ExcludedThreadsRepository;
  candidates: CandidateThreadsRepository;
  contacts: ContactsRepository;
  cursor: InboxCursorRepository;
  speakers: SpeakersRepository;
  events: EventsRepository;
  organisations: OrganisationsRepository;
  tasks: TasksRepository;
  triager: Triager;
  config: InboxConfig;
  /** Counts and flags only. Never a subject, an address or any text from a message. */
  log: (message: string, fields?: Record<string, number | string | boolean>) => void;
}

export interface RetriageReport extends PollReport {
  /** Messages considered for re-triage. */
  considered: number;
}

export interface BackfillReport {
  /** Stored messages whose structure had never been read. */
  needed: number;
  checked: number;
  /** Of those checked: how many carry a List-Unsubscribe header / a calendar part. */
  withListUnsubscribe: number;
  withCalendarPart: number;
  /** Stored messages whose Gmail id was not found in either label folder (moved or unlabelled since). */
  notFound: number;
}

export interface PollOptions {
  /** Only consider messages received on or after this date (a narrowing; the label still scopes). */
  since?: string;
  /** Report what would be stored: reads headers only, fetches no body, calls no model, writes nothing. */
  dryRun?: boolean;
  now?: Date;
}

export interface PollReport {
  /** Gmail ids stored by this poll. */
  stored: string[];
  alreadyStored: number;
  /** Seen, not in scope, and dropped (nothing stored, no body fetched). */
  dropped: number;
  droppedExcluded: number;
  candidatesRecorded: number;
  skippedOutbound: number;
  triaged: number;
  triageFailed: number;
  /** Left pending because the provider was unavailable; retried on the next poll. */
  triagePending: number;
  /** Pending messages left alone because their thread has been excluded since they were stored. */
  triageSkippedExcluded: number;
  /** A folder's UIDVALIDITY changed (it was recreated): its cursor was discarded and it was swept again. */
  uidValidityReset: boolean;
  /** A sweep hit GMAIL_SWEEP_MAX_PAGES: the rest is picked up by the next poll. */
  sweepTruncated: boolean;
  /**
   * Of the messages triaged by this run, how each one's intent was decided. `model` is the model alone;
   * `lookup_*` is a known sender (intent fixed, the model still asked for the rest unless the role is
   * noise); `rule_*` never reached a model.
   */
  decidedBy: Record<DecidedBy, number>;
  /** Messages for which a provider call was made (decidedBy `model`, or a lookup that still asked the model). */
  reachedModel: number;
  /** Messages where two deciders gave DIFFERENT intents: the earlier won and the disagreement is counted here. */
  ruleConflicts: number;
  /** Wall-clock of the whole poll. */
  elapsedMs: number;
  /** `--dry-run` only. */
  wouldStore: { gmailId: string; threadId: string; receivedAt: string; subject: string }[];
}

export class InboxLabelMissingError extends Error {
  constructor(public readonly label: string) {
    super(
      `The Gmail label "${label}" does not exist. Create it in Gmail first: an absent label is an error, never "everything".`,
    );
    this.name = 'InboxLabelMissingError';
  }
}

export class InboxInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxInputError';
  }
}

const emptyReport = (): PollReport => ({
  stored: [],
  alreadyStored: 0,
  dropped: 0,
  droppedExcluded: 0,
  candidatesRecorded: 0,
  skippedOutbound: 0,
  triaged: 0,
  triageFailed: 0,
  triagePending: 0,
  triageSkippedExcluded: 0,
  uidValidityReset: false,
  sweepTruncated: false,
  decidedBy: Object.fromEntries(DECIDED_BY.map((d) => [d, 0])) as Record<DecidedBy, number>,
  reachedModel: 0,
  ruleConflicts: 0,
  elapsedMs: 0,
  wouldStore: [],
});

const OUTBOUND_LABELS = ['SENT', 'DRAFT'];

/** `2026-11-01` or an ISO instant -> `YYYY-MM-DD`. */
function sinceDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime()))
    throw new InboxInputError(`--since must be an ISO date, got "${value}"`);
  return d.toISOString().slice(0, 10);
}

/** The thread-level access-control state for ONE poll: what the database says, plus (dry-run) what it would say. */
class Scope {
  private readonly excludedCache = new Map<string, boolean>();
  private readonly wouldAdmit = new Set<string>();

  constructor(
    private readonly deps: InboxDeps,
    private readonly dryRun: boolean,
    private readonly now: Date,
  ) {}

  async isExcluded(threadId: string): Promise<boolean> {
    const cached = this.excludedCache.get(threadId);
    if (cached !== undefined) return cached;
    const row = await this.deps.excluded.findByThreadId(threadId);
    const value = row?.status === 'excluded';
    this.excludedCache.set(threadId, value);
    return value;
  }

  async isAdmitted(threadId: string): Promise<boolean> {
    if (this.wouldAdmit.has(threadId)) return true;
    return (await this.deps.admitted.findByThreadId(threadId)) !== null;
  }

  /** The label admitted this thread. The stronger label wins over a candidate record. */
  async admitByLabel(threadId: string): Promise<void> {
    if (this.dryRun) {
      this.wouldAdmit.add(threadId);
      return;
    }
    if ((await this.deps.admitted.findByThreadId(threadId)) === null) {
      try {
        await this.deps.admitted.insert({
          threadId,
          admittedAt: this.now.toISOString(),
          admittedBy: 'label',
        });
      } catch (err) {
        if (!(err instanceof DuplicateKeyError)) throw err;
      }
    }
    const candidate = await this.deps.candidates.findByThreadId(threadId);
    if (candidate && candidate.state !== 'admitted') {
      await this.deps.candidates.updateWithRetry(candidate._id, () => ({
        state: 'admitted' as const,
        decidedAt: this.now.toISOString(),
      }));
    }
  }
}

export class InboxService {
  constructor(private readonly deps: InboxDeps) {}

  // =============================================================================================
  // poll
  // =============================================================================================

  /**
   * The order below is what makes the scope guarantee (spec 1) hold:
   *  1. resolve both labels to their folders via LIST; a label that has no folder aborts BEFORE any listing;
   *  2. sweep each folder (opened read-only) for UIDs ABOVE the stored cursor. Applying a label gives a
   *     message a NEW, highest UID in that label's folder, so a message that arrived months ago and was
   *     labelled today is simply a new UID: there is no "labelled at" time to keep and no history feed;
   *  3. every listed message has its ENVELOPE read first (never a body), and only a message that carries
   *     the label goes on to a body fetch; anything else is dropped;
   *  4. the body that comes back is checked AGAIN against the same rule before it is stored;
   *  5. the cursor is saved last, with the UIDVALIDITY it was read under. A changed UIDVALIDITY discards
   *     the folder's cursor and sweeps it again (bounded); the unique Gmail id absorbs what is stored.
   * Mail that is NOT in a label folder is not reachable at all: INBOX and All Mail are never opened.
   */
  async poll(options: PollOptions = {}): Promise<PollReport> {
    const now = options.now ?? new Date();
    const startedAt = Date.now();
    const dry = options.dryRun === true;
    const { gmail, config } = this.deps;
    const report = emptyReport();

    const labelId = await gmail.resolveLabelId(config.label);
    if (labelId === null) throw new InboxLabelMissingError(config.label);
    const candidateId = await gmail.resolveLabelId(config.candidateLabel);
    if (candidateId === null) throw new InboxLabelMissingError(config.candidateLabel);

    const cursor = await this.deps.cursor.get();
    const since = options.since ? sinceDate(options.since) : undefined;
    const scope = new Scope(this.deps, dry, now);
    const ctx: PollCtx = { labelId, candidateId, scope, report, now, dry, seen: new Set() };

    // ---- 2/3/4: the label folder, from the cursor (or from 0 with --since: a deliberate re-read) ----
    const labelled = await this.sweep(labelId, since, since ? null : cursor, report);
    await this.processLabelled(labelled.refs, ctx);

    // ---- candidates: ENVELOPE only, except for a thread that has since been admitted. The candidate
    // folder has NO cursor: it is small, it is re-listed (ids only) each poll, and that is how `admit`
    // reaches the bodies of a thread's messages that were first seen as candidates.
    const candidates = await this.sweep(candidateId, since, null, report);
    await this.processCandidates(candidates.refs, ctx);

    if (!dry) {
      await this.triagePending(report);
      // With --since the sweep re-read old UIDs on purpose and the cursor is left where it was.
      if (!since) await this.saveCursor(cursor, [labelled.state], now, report);
    }
    report.elapsedMs = Date.now() - startedAt;
    this.deps.log('inbox poll', {
      stored: report.stored.length,
      alreadyStored: report.alreadyStored,
      dropped: report.dropped,
      droppedExcluded: report.droppedExcluded,
      candidatesRecorded: report.candidatesRecorded,
      skippedOutbound: report.skippedOutbound,
      triaged: report.triaged,
      triageFailed: report.triageFailed,
      triagePending: report.triagePending,
      reachedModel: report.reachedModel,
      ruleConflicts: report.ruleConflicts,
      elapsedMs: report.elapsedMs,
      uidValidityReset: report.uidValidityReset,
      sweepTruncated: report.sweepTruncated,
      dryRun: dry,
    });
    return report;
  }

  /** UIDs above the cursor, at most `sweepMaxPages` pages; from 0 when the folder's UIDVALIDITY changed. */
  private async sweep(
    folder: string,
    since: string | undefined,
    cursor: InboxCursor | null,
    report: PollReport,
  ): Promise<{ refs: MessageRef[]; state: FolderCursor }> {
    const { gmail, config } = this.deps;
    const prior = cursor?.folders?.find((f) => f.folder === folder);
    let afterUid = prior?.lastUid ?? 0;
    const refs: MessageRef[] = [];
    let uidValidity = prior?.uidValidity ?? '';
    for (let page = 0; page < config.sweepMaxPages; page++) {
      const query = { labelId: folder, ...(since ? { since } : {}), limit: config.sweepPageSize };
      let r = await gmail.listMessageRefs({ ...query, afterUid });
      if (page === 0 && prior && prior.uidValidity !== r.uidValidity) {
        report.uidValidityReset = true; // the folder was recreated: its UIDs mean nothing now
        afterUid = 0;
        r = await gmail.listMessageRefs({ ...query, afterUid });
      }
      uidValidity = r.uidValidity;
      refs.push(...r.refs);
      const last = r.refs.at(-1);
      if (last) afterUid = last.uid;
      if (!r.hasMore) break;
      if (page === config.sweepMaxPages - 1) report.sweepTruncated = true;
    }
    return { refs, state: { folder, uidValidity, lastUid: afterUid } };
  }

  /** Refs from the label folder. Envelope first; the label decides, not the listing. */
  private async processLabelled(refs: readonly MessageRef[], ctx: PollCtx): Promise<void> {
    const known = await this.deps.inbound.knownGmailIds(refs.map((r) => r.id));
    const metas: { ref: MessageRef; meta: GmailMetadata }[] = [];
    for (const ref of refs) {
      if (ctx.seen.has(ref.id)) continue;
      ctx.seen.add(ref.id);
      if (known.has(ref.id)) {
        ctx.report.alreadyStored++;
        continue;
      }
      if (await ctx.scope.isExcluded(ref.threadId)) {
        ctx.report.droppedExcluded++;
        continue;
      }
      metas.push({ ref, meta: await this.deps.gmail.getMetadata(ref) });
    }
    // Pass 1: what carries the label admits its thread. Pass 2: the rest, now that admission is known.
    for (const { ref, meta } of metas.filter((m) => m.meta.labelIds.includes(ctx.labelId))) {
      // NOT admitted here. The label seen in the envelope is a claim; fetchAndStore admits the thread only
      // after the body that comes back confirms it (otherwise its re-check would be checking itself).
      await this.fetchAndStore(ref, ctx, meta);
    }
    for (const { ref, meta } of metas.filter((m) => !m.meta.labelIds.includes(ctx.labelId))) {
      if (await ctx.scope.isAdmitted(meta.threadId)) await this.fetchAndStore(ref, ctx, meta);
      else if (meta.labelIds.includes(ctx.candidateId)) await this.noteCandidate(meta, ctx);
      else ctx.report.dropped++; // listed (a wrong query, say) but not ours: dropped, no body fetch
    }
  }

  /** Candidate refs: only threads not yet known have their ENVELOPE read, once. */
  private async processCandidates(refs: readonly MessageRef[], ctx: PollCtx): Promise<void> {
    const known = await this.deps.inbound.knownGmailIds(refs.map((r) => r.id));
    const fresh: MessageRef[] = [];
    const admittedRefs: MessageRef[] = [];
    for (const ref of refs) {
      if (ctx.seen.has(ref.id) || known.has(ref.id)) continue;
      if (await ctx.scope.isExcluded(ref.threadId)) continue;
      if (await ctx.scope.isAdmitted(ref.threadId)) admittedRefs.push(ref);
      else fresh.push(ref);
    }
    for (const ref of fresh) ctx.seen.add(ref.id);
    // A message in the candidate folder whose THREAD is admitted (by a human, or by the strong label on
    // another message) is in scope like any other: thread-level admission (spec 1a).
    for (const ref of admittedRefs) {
      ctx.seen.add(ref.id);
      await this.fetchAndStore(ref, ctx, await this.deps.gmail.getMetadata(ref));
    }
    const r = await observeCandidateRefs(fresh, this.deps.gmail, {
      candidateLabelId: ctx.candidateId,
      candidates: this.deps.candidates,
      now: ctx.now,
      dryRun: ctx.dry,
    });
    ctx.report.candidatesRecorded += r.recorded;
    ctx.report.dropped += r.rejected; // listed as a candidate, but its own envelope says otherwise
  }

  private async noteCandidate(meta: GmailMetadata, ctx: PollCtx): Promise<void> {
    const outcome = await recordCandidate(meta, {
      candidateLabelId: ctx.candidateId,
      candidates: this.deps.candidates,
      now: ctx.now,
      dryRun: ctx.dry,
    });
    if (outcome === 'recorded') ctx.report.candidatesRecorded++;
  }

  /**
   * The ONLY place a body is fetched, and only for a message already shown (by its headers, or by the
   * admitted thread it belongs to) to be in scope. The response is checked once more before anything
   * is stored.
   */
  private async fetchAndStore(ref: MessageRef, ctx: PollCtx, meta: GmailMetadata): Promise<void> {
    const { gmail } = this.deps;
    // Our own side of the conversation is not inbound mail. Its labels are known BEFORE any body fetch
    // (from the envelope's labels), so its body is never fetched at all.
    if (meta.labelIds.some((l) => OUTBOUND_LABELS.includes(l))) {
      ctx.report.skippedOutbound++;
      return;
    }
    if (ctx.dry) {
      const m = meta;
      // Dry run: the envelope is all there is. A label in them admits the thread IN MEMORY, so later
      // messages of that thread show up as they would on a real poll. Nothing is written.
      if (m.labelIds.includes(ctx.labelId)) await ctx.scope.admitByLabel(m.threadId);
      ctx.report.wouldStore.push({
        gmailId: m.id,
        threadId: m.threadId,
        receivedAt: m.receivedAt,
        subject: m.headers.subject ?? '',
      });
      return;
    }
    const full = await gmail.getFull(ref);
    // The re-check (spec 1.3), on what actually came back and NOT circular: the message's own labels, or
    // an admission that already existed BEFORE this fetch. A thread is admitted by a label only after this
    // passes, never before, so a stale claim (a history record, a label removed since the headers were
    // read) cannot admit the thread and then pass its own check.
    const labelledNow = full.labelIds.includes(ctx.labelId);
    const inScope = labelledNow || (await ctx.scope.isAdmitted(full.threadId));
    if (!inScope || (await ctx.scope.isExcluded(full.threadId))) {
      ctx.report.dropped++;
      return;
    }
    if (labelledNow) await ctx.scope.admitByLabel(full.threadId);
    if (full.labelIds.some((l) => OUTBOUND_LABELS.includes(l))) {
      ctx.report.skippedOutbound++; // our own side of the conversation is not inbound mail
      return;
    }
    const from = parseAddress(full.headers.from) ?? UNKNOWN_SENDER;
    const link = await resolveLink(
      { fromAddress: from.address, threadId: full.threadId },
      this.deps,
    );
    // Effects first and idempotent: a crash before the insert leaves chasing PAUSED, the safe side.
    if (link.speakerId && link.eventIds.length > 0) {
      await recordInbound(this.deps.speakers, link.speakerId, link.eventIds, full.receivedAt);
    }
    await this.noteContact(from, link);
    const redacted = redactForTriage(full.bodyText, this.deps.config.triageMaxChars);
    const input: InboundMessageInput = {
      gmailId: full.id,
      threadId: full.threadId,
      ...(full.headers.messageId ? { rfcMessageId: full.headers.messageId } : {}),
      receivedAt: full.receivedAt,
      from,
      to: parseAddressList(full.headers.to),
      ...(full.headers.cc ? { cc: parseAddressList(full.headers.cc) } : {}),
      ...(full.headers.replyTo ? { replyTo: parseAddressList(full.headers.replyTo) } : {}),
      ...(full.headers.inReplyTo ? { inReplyTo: full.headers.inReplyTo.trim() } : {}),
      ...(full.headers.references
        ? { references: full.headers.references.split(/\s+/).filter(Boolean) }
        : {}),
      subject: full.headers.subject ?? '',
      bodyText: full.bodyText,
      bodyRedacted: redacted,
      bodySnippet: redacted.slice(0, 200),
      labelIds: full.labelIds,
      attachments: full.attachments,
      ...(full.headers.listUnsubscribe ? { listUnsubscribe: full.headers.listUnsubscribe } : {}),
      hasCalendarPart: full.hasCalendarPart,
      structureCheckedAt: ctx.now.toISOString(),
      classification: 'personal',
      triageState: 'pending',
      ...(link.speakerId ? { linkedSpeakerId: link.speakerId } : {}),
      ...(link.organisationId ? { linkedOrganisationId: link.organisationId } : {}),
      ...(link.eventId ? { linkedEventId: link.eventId } : {}),
      linkState: link.linkState,
    };
    const { created } = await this.deps.inbound.insert(input);
    if (created) ctx.report.stored.push(full.id);
    else ctx.report.alreadyStored++;
  }

  /** A person who writes to us is a fact about correspondence, not permission to write to them. */
  private async noteContact(
    from: { name?: string | undefined; address: string },
    link: { speakerId?: string; organisationId?: string },
  ): Promise<void> {
    if (from.address === UNKNOWN_SENDER.address) return;
    const existing = await this.deps.contacts.findByAddress(from.address);
    if (!existing) {
      try {
        await this.deps.contacts.insert({
          ...(from.name ? { name: from.name } : {}),
          address: from.address,
          ...(link.speakerId ? { speakerId: link.speakerId } : {}),
          ...(link.organisationId ? { organisationId: link.organisationId } : {}),
          addedBy: 'inbox',
          addedAt: new Date().toISOString(),
          source: 'replied_to_us',
        });
      } catch (err) {
        if (!(err instanceof DuplicateKeyError)) throw err;
      }
      return;
    }
    if (
      (!existing.speakerId && link.speakerId) ||
      (!existing.organisationId && link.organisationId)
    ) {
      await this.deps.contacts.updateWithRetry(existing._id, () => ({
        ...(!existing.speakerId && link.speakerId ? { speakerId: link.speakerId } : {}),
        ...(!existing.organisationId && link.organisationId
          ? { organisationId: link.organisationId }
          : {}),
      }));
    }
  }

  // =============================================================================================
  // triage
  // =============================================================================================

  /** Triages whatever is pending. The model sees the REDACTED body, which is what is stored. */
  private async triagePending(
    report: PollReport,
    only?: readonly InboundMessage[],
    options: { tasks: boolean } = { tasks: true },
  ): Promise<void> {
    for (const m of only ?? (await this.deps.inbound.findByTriageState('pending', 200))) {
      // Exclusion is checked HERE, at the moment of the provider call, not when the message was stored:
      // a thread excluded after its messages were stored (while the provider was down, say) must not
      // have its body sent afterwards. The message stays as it is; lifting the exclusion lets it proceed.
      if ((await this.deps.excluded.findByThreadId(m.threadId))?.status === 'excluded') {
        report.triageSkippedExcluded++;
        continue;
      }
      try {
        const { verdict, overridden } = await this.classifyStored(m);
        if (overridden.length > 0) report.ruleConflicts++;
        const triagedAt = new Date().toISOString();
        if (verdict.mode === 'rule') {
          // Decided in code: no model, no provider call, nothing leaves the machine.
          const summary = ruleSummary(verdict.intent, verdict.decidedBy);
          await this.deps.inbound.update(m._id, {
            triageState: 'done',
            triage: summary,
            triagedAt,
          });
          report.triaged++;
          report.decidedBy[verdict.decidedBy]++;
          if (options.tasks) await this.raiseTask(m, summary);
          continue;
        }
        const out = await this.deps.triager.run(
          m.bodyRedacted,
          m.attachments,
          verdict.mode === 'fixed-intent'
            ? { intent: verdict.intent, decidedBy: verdict.decidedBy }
            : undefined,
        );
        report.reachedModel++;
        if (out.ok) {
          await this.deps.inbound.update(m._id, {
            triageState: 'done',
            triage: out.summary,
            triagedAt,
          });
          report.triaged++;
          report.decidedBy[verdict.mode === 'fixed-intent' ? verdict.decidedBy : 'model']++;
        } else {
          await this.deps.inbound.update(m._id, {
            triageState: 'failed',
            triageFailure: out.issues,
            triagedAt,
          });
          report.triageFailed++;
        }
        if (options.tasks) await this.raiseTask(m, out.ok ? out.summary : undefined);
      } catch (err) {
        if (!(err instanceof ProviderUnavailableError)) throw err;
        report.triagePending++;
        return; // an outage: leave the rest pending, retry next poll
      }
    }
  }

  /**
   * Who is this sender to us, and what do the message's own headers say? Resolved from the speakers and
   * contacts a human maintains, then from the stored structure (List-Unsubscribe, calendar part).
   */
  private async classifyStored(m: InboundMessage): Promise<Classification> {
    const [speaker, contact] = await Promise.all([
      this.deps.speakers.findByEmail(m.from.address),
      this.deps.contacts.findByAddress(m.from.address),
    ]);
    return classify(
      {
        fromAddress: m.from.address,
        listUnsubscribe: m.listUnsubscribe,
        hasCalendarPart: m.hasCalendarPart,
        isSpeaker: speaker !== null,
        contactRole: contact?.role,
      },
      this.deps.config.documentShareSenders,
    );
  }

  /**
   * Triage changes nothing in the domain (spec 7.3). It raises a TASK for a human, idempotent per
   * message, when something needs a decision: an acceptance, a decline, material, an unsure or failed
   * classification. A task title never carries text a model or a sender wrote beyond the sender's name.
   */
  private async raiseTask(m: InboundMessage, summary: InboundMessage['triage']): Promise<void> {
    const who = m.from.name?.trim() || m.from.address;
    let title: string | null = null;
    if (!summary) title = `Read the reply from ${who}: triage could not classify it`;
    else if (summary.needs_human) title = `Read the message from ${who}: triage asked for a human`;
    else if (summary.sentiment_decision === 'accepts')
      title = `${who} appears to accept: confirm their status yourself`;
    else if (summary.sentiment_decision === 'declines')
      title = `${who} appears to decline: confirm and update their status yourself`;
    else if (summary.sentiment_decision === 'sends_material')
      title = `${who} sent material: check it`;
    if (!title) return;
    const key = `inbound:${m.gmailId}`;
    const open = [
      ...(await allPages((after) =>
        this.deps.tasks.findByStatus('open', { limit: 200, ...(after ? { after } : {}) }),
      )),
      ...(await allPages((after) =>
        this.deps.tasks.findByStatus('doing', { limit: 200, ...(after ? { after } : {}) }),
      )),
    ];
    if (open.some((t) => t.milestoneKey === key)) return;
    await this.deps.tasks.insert({
      title,
      owner: 'organiser',
      status: 'open',
      source: 'agent',
      ...(m.linkedEventId ? { relatedEventId: m.linkedEventId } : {}),
      ...(m.linkedSpeakerId ? { relatedSpeakerId: m.linkedSpeakerId } : {}),
      milestoneKey: key,
    });
  }

  private async saveCursor(
    current: InboxCursor | null,
    states: readonly FolderCursor[],
    now: Date,
    report: PollReport,
  ): Promise<void> {
    const folders = [
      ...(current?.folders ?? []).filter((f) => !states.some((s) => s.folder === f.folder)),
      ...states,
    ];
    const patch = {
      folders,
      lastPollAt: now.toISOString(),
      ...(report.uidValidityReset ? { lastUidValidityResetAt: now.toISOString() } : {}),
    };
    if (current) await this.deps.cursor.updateWithRetry(current._id, () => patch);
    else await this.deps.cursor.insert({ key: 'gmail', ...patch });
  }

  /**
   * Runs every stored message through the CURRENT triage (lookup, rules, then the model for what is left),
   * replacing its summary. For when the taxonomy or the rules changed. Raises no tasks: the first triage
   * already did, and re-raising for messages a human has since handled would be noise.
   */
  async retriage(options: { limit?: number } = {}): Promise<RetriageReport> {
    const startedAt = Date.now();
    const report: RetriageReport = { ...emptyReport(), considered: 0 };
    const all = await this.deps.inbound.findRecent(options.limit ?? 5000);
    for (const m of all) {
      report.considered++;
      const pending = await this.deps.inbound.update(m._id, { triageState: 'pending' });
      await this.triagePending(report, [pending ?? m], { tasks: false });
      if (report.triagePending > 0) break; // a provider outage: the rest stay as they were
    }
    report.elapsedMs = Date.now() - startedAt;
    return report;
  }

  /**
   * Reads List-Unsubscribe and the calendar part for STORED messages that were stored before those were
   * recorded. Headers and BODYSTRUCTURE only: no part is downloaded, nothing is stored that was not already
   * in scope, and a message outside both label folders (or in an excluded thread) is left alone.
   */
  async backfillStructure(): Promise<BackfillReport> {
    const { gmail, config } = this.deps;
    const labelId = await gmail.resolveLabelId(config.label);
    if (labelId === null) throw new InboxLabelMissingError(config.label);
    const candidateId = await gmail.resolveLabelId(config.candidateLabel);
    if (candidateId === null) throw new InboxLabelMissingError(config.candidateLabel);
    const stored = await this.deps.inbound.findRecent(10_000);
    const wanted = new Map(
      stored.filter((m) => m.structureCheckedAt === undefined).map((m) => [m.gmailId, m]),
    );
    const report: BackfillReport = {
      needed: wanted.size,
      checked: 0,
      withListUnsubscribe: 0,
      withCalendarPart: 0,
      notFound: 0,
    };
    const scratch = emptyReport();
    for (const folder of [labelId, candidateId]) {
      if (wanted.size === 0) break;
      const { refs } = await this.sweep(folder, undefined, null, scratch);
      for (const ref of refs) {
        const m = wanted.get(ref.id);
        if (!m) continue; // not stored: never read
        if ((await this.deps.excluded.findByThreadId(m.threadId))?.status === 'excluded') continue;
        const st = await gmail.getStructure(ref);
        await this.deps.inbound.update(m._id, {
          ...(st.listUnsubscribe ? { listUnsubscribe: st.listUnsubscribe } : {}),
          hasCalendarPart: st.hasCalendarPart,
          structureCheckedAt: new Date().toISOString(),
        });
        wanted.delete(ref.id);
        report.checked++;
        if (st.listUnsubscribe) report.withListUnsubscribe++;
        if (st.hasCalendarPart) report.withCalendarPart++;
      }
    }
    report.notFound = wanted.size;
    return report;
  }

  /** A human says what a sender IS to us. A contact is created (source `added_by_human`) if there is none. */
  async setContactRole(
    address: string,
    role: ContactRole,
    by: string,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const existing = await this.deps.contacts.findByAddress(address);
    if (existing) {
      if (existing.role === role) return 'unchanged';
      await this.deps.contacts.updateWithRetry(existing._id, () => ({ role }));
      return 'updated';
    }
    await this.deps.contacts.insert({
      address: address.trim().toLowerCase(),
      role,
      addedBy: by,
      addedAt: new Date().toISOString(),
      source: 'added_by_human',
    });
    return 'created';
  }

  /** Everything the rule validation needs from the database, and nothing it should not (no bodies). */
  async validationInputs(): Promise<{
    messages: InboundMessage[];
    speakerEmails: Set<string>;
    contactRoles: Map<string, ContactRole>;
    documentShareSenders: string[];
  }> {
    const messages = await this.deps.inbound.findRecent(10_000);
    const speakerEmails = new Set<string>();
    for (const m of messages) {
      if ((await this.deps.speakers.findByEmail(m.from.address)) !== null) {
        speakerEmails.add(m.from.address);
      }
    }
    const contactRoles = new Map<string, ContactRole>();
    for (const m of messages) {
      const c = await this.deps.contacts.findByAddress(m.from.address);
      if (c?.role) contactRoles.set(c.address, c.role);
    }
    return {
      messages,
      speakerEmails,
      contactRoles,
      documentShareSenders: this.deps.config.documentShareSenders,
    };
  }

  // =============================================================================================
  // the human's decisions: candidates, admission, exclusion
  // =============================================================================================

  async listCandidates(): Promise<CandidateThread[]> {
    return await allPages((after) =>
      this.deps.candidates.findByState('pending', { limit: 200, ...(after ? { after } : {}) }),
    );
  }

  /** Promotes a thread to admission. The decision is stored in its own record. */
  async admit(threadId: string, by: string): Promise<void> {
    if ((await this.deps.excluded.findByThreadId(threadId))?.status === 'excluded') {
      throw new InboxInputError(`Thread ${threadId} is excluded: run include-thread first.`);
    }
    if ((await this.deps.admitted.findByThreadId(threadId)) === null) {
      await this.deps.admitted.insert({
        threadId,
        admittedAt: new Date().toISOString(),
        admittedBy: 'human',
      });
    }
    const candidate = await this.deps.candidates.findByThreadId(threadId);
    if (candidate) {
      await this.deps.candidates.updateWithRetry(candidate._id, () => ({
        state: 'admitted' as const,
        decidedAt: new Date().toISOString(),
        reason: `admitted by ${by}`,
      }));
    }
    this.deps.log('inbox admit', { by });
  }

  async dismiss(threadId: string, reason?: string): Promise<void> {
    const candidate = await this.deps.candidates.findByThreadId(threadId);
    if (!candidate)
      throw new InboxInputError(`No candidate thread ${threadId}: see "inbox candidates".`);
    await this.deps.candidates.updateWithRetry(candidate._id, () => ({
      state: 'dismissed' as const,
      decidedAt: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    }));
  }

  /** Undoes a dismissal: the thread is a pending candidate again. */
  async undismiss(threadId: string): Promise<void> {
    const candidate = await this.deps.candidates.findByThreadId(threadId);
    if (candidate?.state !== 'dismissed')
      throw new InboxInputError(`Thread ${threadId} is not dismissed.`);
    await this.deps.candidates.updateWithRetry(candidate._id, () => ({
      state: 'pending' as const,
      decidedAt: new Date().toISOString(),
    }));
  }

  /** After this nothing further from the thread is fetched, stored or triaged, even if it is labelled. */
  async excludeThread(threadId: string, reason: string): Promise<void> {
    if (!reason.trim()) throw new InboxInputError('exclude-thread needs a reason');
    const existing = await this.deps.excluded.findByThreadId(threadId);
    const now = new Date().toISOString();
    if (!existing) {
      await this.deps.excluded.insert({ threadId, reason, excludedAt: now, status: 'excluded' });
      return;
    }
    await this.deps.excluded.updateWithRetry(existing._id, () => ({
      status: 'excluded' as const,
      reason,
      excludedAt: now,
    }));
  }

  /** Lifts an exclusion (a status; nothing is deleted). */
  async includeThread(threadId: string): Promise<void> {
    const existing = await this.deps.excluded.findByThreadId(threadId);
    if (existing?.status !== 'excluded')
      throw new InboxInputError(`Thread ${threadId} is not excluded.`);
    await this.deps.excluded.updateWithRetry(existing._id, () => ({
      status: 'lifted' as const,
      liftedAt: new Date().toISOString(),
    }));
  }

  // =============================================================================================
  // reading and linking
  // =============================================================================================

  async listMessages(limit = 50): Promise<InboundMessage[]> {
    return await this.deps.inbound.findRecent(limit);
  }

  async showMessage(id: string): Promise<InboundMessage | null> {
    return await this.deps.inbound.findById(id);
  }

  /** The raw body. Callers: this module and the inbox CLI, nothing else (source-scanned). */
  async getRawBody(id: string): Promise<string | null> {
    return await this.deps.inbound.getRawBody(id);
  }

  /** A human links a message: `inbox link <id> --speaker <id> --event <id>`. */
  async link(
    messageId: string,
    speakerId: string,
    eventId: string,
    options: { adoptAddress?: boolean } = {},
  ): Promise<InboundMessage & { adoptedAddress?: string }> {
    const message = await this.deps.inbound.findById(messageId);
    if (!message) throw new InboxInputError(`No inbound message ${messageId}`);
    const speaker = await this.deps.speakers.findById(speakerId);
    if (!speaker) throw new InboxInputError(`No speaker ${speakerId}`);
    if (!speaker.perEvent.some((p) => p.eventId.toLowerCase() === eventId.toLowerCase())) {
      throw new InboxInputError(`Speaker ${speakerId} has no pipeline entry for event ${eventId}`);
    }
    // Human-initiated only: without the flag nothing about the speaker's identity changes.
    const adoptedAddress = options.adoptAddress
      ? await this.adoptAddress(speaker, message.from.address)
      : undefined;
    const updated = await this.deps.inbound.update(messageId, {
      linkedSpeakerId: speakerId,
      linkedEventId: eventId,
      linkState: 'confirmed_by_human',
    });
    await recordInbound(this.deps.speakers, speakerId, [eventId], message.receivedAt);
    await this.noteContact(message.from, { speakerId });
    return { ...(updated ?? message), ...(adoptedAddress ? { adoptedAddress } : {}) };
  }

  /**
   * Records the sender's address on the speaker (`inbox link --adopt-address`). Refused when the address is
   * unknown or already belongs to another speaker. Returns the address when it was added, nothing when the
   * speaker already had it.
   */
  private async adoptAddress(
    speaker: { _id: string; emails: string[] },
    address: string,
  ): Promise<string | undefined> {
    if (address === UNKNOWN_SENDER.address) {
      throw new InboxInputError('This message has no usable sender address to adopt.');
    }
    if (speaker.emails.includes(address)) return undefined;
    const owner = await this.deps.speakers.findByEmail(address);
    if (owner && owner._id !== speaker._id) {
      throw new InboxInputError(
        `That address already belongs to another speaker (${owner._id}): not adopted.`,
      );
    }
    await this.deps.speakers.updateWithRetry(speaker._id, (s) => ({
      emails: s.emails.includes(address) ? s.emails : [...s.emails, address],
    }));
    return address;
  }

  /** Re-runs triage for a message whose triage failed (and nothing else). */
  async retryTriage(messageId: string): Promise<InboundMessage> {
    const message = await this.deps.inbound.findById(messageId);
    if (!message) throw new InboxInputError(`No inbound message ${messageId}`);
    if (message.triageState === 'done')
      throw new InboxInputError('Triage already succeeded for this message.');
    if ((await this.deps.excluded.findByThreadId(message.threadId))?.status === 'excluded') {
      throw new InboxInputError(
        `Thread ${message.threadId} is excluded: nothing from it is triaged. Run include-thread first.`,
      );
    }
    const pending = await this.deps.inbound.update(messageId, { triageState: 'pending' });
    // Only this message: a retry does not re-triage everything else that happens to be pending.
    await this.triagePending(emptyReport(), [pending ?? message]);
    return (await this.deps.inbound.findById(messageId)) ?? message;
  }
}

interface PollCtx {
  labelId: string;
  candidateId: string;
  scope: Scope;
  report: PollReport;
  now: Date;
  dry: boolean;
  /** Gmail ids already handled in this poll: nothing is fetched or triaged twice. */
  seen: Set<string>;
}
