import {
  type SpeakerReviewPayload,
  SpeakerReviewPayloadSchema,
} from '../../approvals/speaker-review.payload.js';
import type { Redraft } from './decide.js';
import { GraphRuntime, type RetentionPort, type ThreadView } from '../../graph/runtime.js';
import type { ThreadLock } from '../../graph/thread-lock.js';
import { NODE_REQUEST_APPROVAL, type SpeakersGraph } from './speakers.graph.js';

export type SpeakersThreadView = ThreadView<SpeakerReviewPayload>;

/** The Speakers agent's runtime: the generic one, plus a typed start. */
export class SpeakersRuntime extends GraphRuntime<SpeakerReviewPayload> {
  constructor(graph: SpeakersGraph, retention: RetentionPort, lock: ThreadLock) {
    super(graph, retention, lock, {
      purpose: 'speakers',
      approvalNode: NODE_REQUEST_APPROVAL,
      reviewSchema: SpeakerReviewPayloadSchema,
    });
  }

  async start(
    threadId: string,
    input: { eventId: string; now?: Date; redraft?: readonly Redraft[] },
  ): Promise<SpeakersThreadView> {
    return await this.startWith(threadId, {
      eventId: input.eventId,
      // Always written: a reused thread must not inherit the previous run's "today".
      nowIso: input.now ? input.now.toISOString() : null,
      // Per-run input, like "today": never inherited from the previous run on a reused thread.
      redraft: input.redraft ? [...input.redraft] : null,
    });
  }
}
