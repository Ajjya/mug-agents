import type { CandidateThread } from '../domain/inbox.schema.js';
import type { GmailMetadata, GmailMetadataClient, MessageRef } from './gmail.transport.js';
import { UNKNOWN_SENDER, parseAddress } from './address.js';
import type { CandidateThreadsRepository } from './repositories.js';

/**
 * THE CANDIDATE PATH (spec 1.1). Everything here is typed against {@link GmailMetadataClient}, which
 * has NO method that returns a body, so a candidate's body is unreachable from this file, not merely
 * unused. A source scan (test/unit/inbox-raw-body.test.ts) fails if this file ever mentions a body
 * fetch. Candidate metadata is a thread's subject, sender and last-seen time; the record has no field
 * that could hold anything more.
 */

export interface CandidateContext {
  candidates: CandidateThreadsRepository;
  now: Date;
  dryRun: boolean;
}

/** A thread we already know about (recorded, dismissed, or admitted) is not read again. */
export async function isKnownThread(
  candidates: CandidateThreadsRepository,
  threadId: string,
): Promise<boolean> {
  return (await candidates.findByThreadId(threadId)) !== null;
}

/** Records (or refreshes) a candidate thread from its HEADERS. Never touches a dismissed thread. */
export async function recordCandidate(
  meta: GmailMetadata,
  ctx: CandidateContext,
): Promise<'recorded' | 'refreshed' | 'dismissed'> {
  const existing = await ctx.candidates.findByThreadId(meta.threadId);
  if (existing?.state === 'dismissed') return 'dismissed';
  if (ctx.dryRun) return existing ? 'refreshed' : 'recorded';
  if (existing) {
    await ctx.candidates.updateWithRetry(existing._id, () => ({
      lastSeenAt: ctx.now.toISOString(),
    }));
    return 'refreshed';
  }
  await ctx.candidates.insert({
    threadId: meta.threadId,
    subject: meta.headers.subject ?? '',
    from: parseAddress(meta.headers.from) ?? UNKNOWN_SENDER,
    lastSeenAt: ctx.now.toISOString(),
    state: 'pending',
  });
  return 'recorded';
}

/**
 * Candidate refs from a label listing: only threads not yet known have their headers read, once.
 * `meta` is the metadata-only client: there is no body method on it to call.
 */
export async function observeCandidateRefs(
  refs: readonly MessageRef[],
  meta: GmailMetadataClient,
  ctx: CandidateContext,
): Promise<{ recorded: number; skipped: number }> {
  let recorded = 0;
  let skipped = 0;
  const seenThreads = new Set<string>();
  for (const ref of refs) {
    if (seenThreads.has(ref.threadId) || (await isKnownThread(ctx.candidates, ref.threadId))) {
      skipped++;
      continue;
    }
    seenThreads.add(ref.threadId);
    const outcome = await recordCandidate(await meta.getMetadata(ref.id), ctx);
    if (outcome === 'recorded') recorded++;
    else skipped++;
  }
  return { recorded, skipped };
}

export type { CandidateThread };
