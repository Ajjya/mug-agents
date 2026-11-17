import type { SpeakerStatus } from '../../domain/speaker.schema.js';
import type { ChasePolicy, PipelineInput } from './decide.js';
import type { LoadedPipeline } from './speakers.store.js';

/** A speaker's status for the event; `idea` if the entry is missing (cannot happen for a loaded one). */
export function statusFor(
  speaker: LoadedPipeline['speakers'][number],
  eventId: string,
): SpeakerStatus {
  return (
    speaker.perEvent.find((e) => e.eventId.toLowerCase() === eventId.toLowerCase())?.status ??
    'idea'
  );
}

/**
 * The one mapping from stored documents to decideActions' input. `speakers run` (the graph) and
 * `speakers list` both use it, so what the table shows and what a run does cannot drift apart.
 */
export function pipelineInput(p: LoadedPipeline, now: Date, policy: ChasePolicy): PipelineInput {
  return {
    now,
    eventDate: p.event.date,
    policy,
    speakers: p.speakers.map((s) => ({
      id: s._id,
      name: s.name,
      status: statusFor(s, p.event._id),
      hasBio: Boolean(s.bio?.trim()),
      hasPhoto: Boolean(s.photoUrl),
    })),
    messages: p.messages.map((m) => ({
      id: m._id,
      speakerId: m.speakerId,
      kind: m.kind,
      round: m.round,
      status: m.status,
      ...(m.sentAt ? { sentAt: m.sentAt } : {}),
    })),
  };
}
