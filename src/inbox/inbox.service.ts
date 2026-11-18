import type {
  CandidateThread,
  InboundMessage,
  InboundMessageInput,
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
import {
  type GmailClient,
  type GmailMetadata,
  HistoryExpiredError,
  type HistoryRecord,
  type MessageRef,
} from './gmail.transport.js';
import type { InboxConfig } from './inbox.config.js';
import { recordInbound, resolveLink } from './linking.js';
import { redactForTriage } from './redact.js';
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
  historyUsed: boolean;
  historyExpired: boolean;
  /** The label sweep hit GMAIL_SWEEP_MAX_PAGES: older labelled mail may not have been listed. */
  sweepTruncated: boolean;
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
  historyUsed: false,
  historyExpired: false,
  sweepTruncated: false,
  wouldStore: [],
});

const DAY_MS = 86_400_000;
const MAX_HISTORY_PAGES = 20;
const OUTBOUND_LABELS = ['SENT', 'DRAFT'];

/** `2026-11-01` or an ISO instant -> Gmail's `YYYY/MM/DD`. */
function gmailDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime()))
    throw new InboxInputError(`--since must be an ISO date, got "${value}"`);
  return `${String(d.getUTCFullYear())}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
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

  wouldAdmitThreads(): string[] {
    return [...this.wouldAdmit];
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
   *  1. resolve both labels; a label that does not exist aborts BEFORE any listing;
   *  2. capture the mailbox's current history id BEFORE reading anything, so mail arriving mid-poll is
   *     seen by the next one;
   *  3. sweep BY LABEL (ids only; the transport cannot express an unscoped list). Gmail exposes no
   *     "labelled at" time, so there is nothing to keep a high-water mark over: the sweep re-lists the
   *     label every poll, bounded by GMAIL_SWEEP_MAX_PAGES, and the unique gmailId absorbs the repeats;
   *  4. every listed id has its HEADERS read first (never a body), and only a message that carries the
   *     label, or sits in an admitted thread, goes on to a body fetch; anything else is dropped;
   *  5. the body that comes back is checked AGAIN against the same rule before it is stored;
   *  6. history and the admitted-thread sweep add later, unlabelled replies. History only helps: what it
   *     reports is filtered on the labels and thread it reports, and a message it names that neither
   *     carries a label nor sits in an admitted thread is dropped without even its headers being read.
   */
  async poll(options: PollOptions = {}): Promise<PollReport> {
    const now = options.now ?? new Date();
    const dry = options.dryRun === true;
    const { gmail, config } = this.deps;
    const report = emptyReport();

    const labelId = await gmail.resolveLabelId(config.label);
    if (labelId === null) throw new InboxLabelMissingError(config.label);
    const candidateId = await gmail.resolveLabelId(config.candidateLabel);
    if (candidateId === null) throw new InboxLabelMissingError(config.candidateLabel);

    const cursor = await this.deps.cursor.get();
    const headHistoryId = await gmail.getCurrentHistoryId();
    const after = options.since ? gmailDate(options.since) : undefined;
    const scope = new Scope(this.deps, dry, now);
    const ctx: PollCtx = { labelId, candidateId, scope, report, now, dry, seen: new Set() };

    // ---- 3/4/5: the label sweep ----
    const labelled = await this.sweep(labelId, after, report);
    await this.processLabelled(labelled, ctx);

    // ---- candidates: headers only, on a client type that has no body method ----
    const candidateRefs = await this.sweep(candidateId, after, report);
    await this.processCandidates(candidateRefs, ctx);

    // ---- 6: history (an optimisation) ----
    if (cursor?.historyId) {
      try {
        const records = await this.history(cursor.historyId);
        report.historyUsed = true;
        await this.processHistory(records, ctx);
      } catch (err) {
        if (!(err instanceof HistoryExpiredError)) throw err;
        report.historyExpired = true; // the sweep above already ran: a bounded backfill, never the mailbox
      }
    }

    // ---- 6: later replies in admitted threads ----
    await this.processAdmittedThreads(ctx);

    if (!dry) {
      await this.triagePending(report);
      await this.saveCursor(headHistoryId, now, report.historyExpired);
    }
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
      historyUsed: report.historyUsed,
      historyExpired: report.historyExpired,
      sweepTruncated: report.sweepTruncated,
      dryRun: dry,
    });
    return report;
  }

  /** Ids by label, at most `sweepMaxPages` pages. */
  private async sweep(
    labelId: string,
    after: string | undefined,
    report: PollReport,
  ): Promise<MessageRef[]> {
    const refs: MessageRef[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < this.deps.config.sweepMaxPages; page++) {
      const r = await this.deps.gmail.listMessageRefs({
        labelId,
        ...(after ? { after } : {}),
        ...(pageToken ? { pageToken } : {}),
      });
      refs.push(...r.refs);
      pageToken = r.nextPageToken;
      if (!pageToken) return refs;
    }
    report.sweepTruncated = true;
    return refs;
  }

  private async history(startHistoryId: string): Promise<HistoryRecord[]> {
    const records: HistoryRecord[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const r = await this.deps.gmail.listHistory(startHistoryId, pageToken);
      records.push(...r.records);
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return records;
  }

  /** Refs from the label query. Headers first; the label decides, not the query. */
  private async processLabelled(refs: readonly MessageRef[], ctx: PollCtx): Promise<void> {
    const known = await this.deps.inbound.knownGmailIds(refs.map((r) => r.id));
    const metas: GmailMetadata[] = [];
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
      metas.push(await this.deps.gmail.getMetadata(ref.id));
    }
    // Pass 1: what carries the label admits its thread. Pass 2: the rest, now that admission is known.
    for (const meta of metas.filter((m) => m.labelIds.includes(ctx.labelId))) {
      await ctx.scope.admitByLabel(meta.threadId);
      await this.fetchAndStore(meta.id, ctx, meta);
    }
    for (const meta of metas.filter((m) => !m.labelIds.includes(ctx.labelId))) {
      if (await ctx.scope.isAdmitted(meta.threadId)) await this.fetchAndStore(meta.id, ctx, meta);
      else if (meta.labelIds.includes(ctx.candidateId)) await this.noteCandidate(meta, ctx);
      else ctx.report.dropped++; // listed (a wrong query, say) but not ours: dropped, no body fetch
    }
  }

  /** Candidate refs: only threads not yet known have their headers read, once. */
  private async processCandidates(refs: readonly MessageRef[], ctx: PollCtx): Promise<void> {
    const known = await this.deps.inbound.knownGmailIds(refs.map((r) => r.id));
    const fresh: MessageRef[] = [];
    for (const ref of refs) {
      if (ctx.seen.has(ref.id) || known.has(ref.id)) continue;
      if ((await ctx.scope.isExcluded(ref.threadId)) || (await ctx.scope.isAdmitted(ref.threadId)))
        continue;
      fresh.push(ref);
    }
    for (const ref of fresh) ctx.seen.add(ref.id);
    const r = await observeCandidateRefs(fresh, this.deps.gmail, {
      candidates: this.deps.candidates,
      now: ctx.now,
      dryRun: ctx.dry,
    });
    ctx.report.candidatesRecorded += r.recorded;
  }

  private async noteCandidate(meta: GmailMetadata, ctx: PollCtx): Promise<void> {
    const outcome = await recordCandidate(meta, {
      candidates: this.deps.candidates,
      now: ctx.now,
      dryRun: ctx.dry,
    });
    if (outcome === 'recorded') ctx.report.candidatesRecorded++;
  }

  /**
   * History records are filtered on what THEY say, before any fetch: a label we own, an admitted
   * thread, or a candidate label. A private message the feed mentions is dropped with no fetch at all.
   */
  private async processHistory(records: readonly HistoryRecord[], ctx: PollCtx): Promise<void> {
    const known = await this.deps.inbound.knownGmailIds(records.map((r) => r.messageId));
    for (const rec of records) {
      if (ctx.seen.has(rec.messageId)) continue;
      if (known.has(rec.messageId)) {
        ctx.seen.add(rec.messageId);
        continue;
      }
      if (await ctx.scope.isExcluded(rec.threadId)) {
        ctx.seen.add(rec.messageId);
        ctx.report.droppedExcluded++;
        continue;
      }
      if (rec.labelIds.includes(ctx.labelId)) {
        ctx.seen.add(rec.messageId);
        const meta = await this.deps.gmail.getMetadata(rec.messageId);
        await ctx.scope.admitByLabel(meta.threadId);
        await this.fetchAndStore(meta.id, ctx, meta);
      } else if (await ctx.scope.isAdmitted(rec.threadId)) {
        ctx.seen.add(rec.messageId);
        await this.fetchAndStore(rec.messageId, ctx);
      } else if (rec.labelIds.includes(ctx.candidateId)) {
        ctx.seen.add(rec.messageId);
        await this.processCandidates([{ id: rec.messageId, threadId: rec.threadId }], {
          ...ctx,
          seen: new Set(),
        });
      } else {
        ctx.seen.add(rec.messageId);
        ctx.report.dropped++; // never fetched, headers included
      }
    }
  }

  /** Admitted threads with recent activity are checked for later replies that carry no label. */
  private async processAdmittedThreads(ctx: PollCtx): Promise<void> {
    const { config } = this.deps;
    const cutoff = ctx.now.getTime() - config.threadSweepDays * DAY_MS;
    const activity = new Map<string, number>();
    for (const t of await this.deps.admitted.findRecent(Math.max(config.threadSweepMax * 2, 50))) {
      const msgs = await this.deps.inbound.findByThreadId(t.threadId);
      const last = Math.max(Date.parse(t.admittedAt), ...msgs.map((m) => Date.parse(m.receivedAt)));
      activity.set(t.threadId, last);
    }
    for (const id of ctx.scope.wouldAdmitThreads()) activity.set(id, ctx.now.getTime());
    const threads = [...activity.entries()]
      .filter(([, last]) => last >= cutoff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, config.threadSweepMax)
      .map(([id]) => id);

    for (const threadId of threads) {
      if (await ctx.scope.isExcluded(threadId)) continue;
      const refs = await this.deps.gmail.getThreadRefs(threadId);
      const unseen = refs.messages.filter((m) => !ctx.seen.has(m.id));
      const known = await this.deps.inbound.knownGmailIds(unseen.map((m) => m.id));
      for (const m of unseen) {
        ctx.seen.add(m.id);
        if (known.has(m.id)) {
          ctx.report.alreadyStored++;
          continue;
        }
        await this.fetchAndStore(m.id, ctx);
      }
    }
  }

  /**
   * The ONLY place a body is fetched, and only for a message already shown (by its headers, or by the
   * admitted thread it belongs to) to be in scope. The response is checked once more before anything
   * is stored.
   */
  private async fetchAndStore(id: string, ctx: PollCtx, meta?: GmailMetadata): Promise<void> {
    const { gmail } = this.deps;
    if (ctx.dry) {
      const m = meta ?? (await gmail.getMetadata(id));
      ctx.report.wouldStore.push({
        gmailId: m.id,
        threadId: m.threadId,
        receivedAt: m.receivedAt,
        subject: m.headers.subject ?? '',
      });
      return;
    }
    const full = await gmail.getFull(id);
    // Belt and braces: the label, or an admitted thread, on what actually came back.
    const inScope =
      full.labelIds.includes(ctx.labelId) || (await ctx.scope.isAdmitted(full.threadId));
    if (!inScope || (await ctx.scope.isExcluded(full.threadId))) {
      ctx.report.dropped++;
      return;
    }
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
      subject: full.headers.subject ?? '',
      bodyText: full.bodyText,
      bodyRedacted: redacted,
      bodySnippet: redacted.slice(0, 200),
      labelIds: full.labelIds,
      attachments: full.attachments,
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
  private async triagePending(report: PollReport): Promise<void> {
    for (const m of await this.deps.inbound.findByTriageState('pending', 200)) {
      try {
        const out = await this.deps.triager.run(m.bodyRedacted, m.attachments);
        const triagedAt = new Date().toISOString();
        if (out.ok) {
          await this.deps.inbound.update(m._id, {
            triageState: 'done',
            triage: out.summary,
            triagedAt,
          });
          report.triaged++;
        } else {
          await this.deps.inbound.update(m._id, {
            triageState: 'failed',
            triageFailure: out.issues,
            triagedAt,
          });
          report.triageFailed++;
        }
        await this.raiseTask(m, out.ok ? out.summary : undefined);
      } catch (err) {
        if (!(err instanceof ProviderUnavailableError)) throw err;
        report.triagePending++;
        return; // an outage: leave the rest pending, retry next poll
      }
    }
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

  private async saveCursor(historyId: string, now: Date, expired: boolean): Promise<void> {
    const current = await this.deps.cursor.get();
    const patch = {
      historyId,
      lastPollAt: now.toISOString(),
      ...(expired ? { lastHistoryExpiredAt: now.toISOString() } : {}),
    };
    if (current) await this.deps.cursor.updateWithRetry(current._id, () => patch);
    else await this.deps.cursor.insert({ key: 'gmail', ...patch });
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
  async link(messageId: string, speakerId: string, eventId: string): Promise<InboundMessage> {
    const message = await this.deps.inbound.findById(messageId);
    if (!message) throw new InboxInputError(`No inbound message ${messageId}`);
    const speaker = await this.deps.speakers.findById(speakerId);
    if (!speaker) throw new InboxInputError(`No speaker ${speakerId}`);
    if (!speaker.perEvent.some((p) => p.eventId.toLowerCase() === eventId.toLowerCase())) {
      throw new InboxInputError(`Speaker ${speakerId} has no pipeline entry for event ${eventId}`);
    }
    const updated = await this.deps.inbound.update(messageId, {
      linkedSpeakerId: speakerId,
      linkedEventId: eventId,
      linkState: 'confirmed_by_human',
    });
    await recordInbound(this.deps.speakers, speakerId, [eventId], message.receivedAt);
    await this.noteContact(message.from, { speakerId });
    return updated ?? message;
  }

  /** Re-runs triage for a message whose triage failed (and nothing else). */
  async retryTriage(messageId: string): Promise<InboundMessage> {
    const message = await this.deps.inbound.findById(messageId);
    if (!message) throw new InboxInputError(`No inbound message ${messageId}`);
    if (message.triageState === 'done')
      throw new InboxInputError('Triage already succeeded for this message.');
    await this.deps.inbound.update(messageId, { triageState: 'pending' });
    await this.triagePending(emptyReport());
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
