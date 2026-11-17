import type { Event } from '../../domain/event.schema.js';
import type { MessageKind } from '../../domain/message.schema.js';
import type { Speaker } from '../../domain/speaker.schema.js';
import type { RetrievalService } from '../../retrieval/retrieval.service.js';
import type { ChunkView } from '../../retrieval/vector-store.js';
import type { DraftContext } from './speakers.graph.js';

/**
 * Context for a draft from M3's search, public scope only: the speaker's own past abstracts (chunks a
 * human tagged with that speaker in the manifest) and the host notes for the event's venue. At most
 * a few chunks: they set the tone, they are never a source of facts.
 */
export class RetrievalDraftContext implements DraftContext {
  constructor(
    private readonly retrieval: RetrievalService,
    private readonly maxChunks = 4,
  ) {}

  async forDraft(event: Event, speaker: Speaker, kind: MessageKind): Promise<ChunkView[]> {
    const topic = [event.theme ?? event.title, ...speaker.topics].join(' ');
    const abstracts = (
      await this.retrieval.search(topic, { kind: 'abstract', classification: ['public'], limit: 8 })
    )
      .map((h) => h.chunk)
      .filter((c) => c.speakerId?.toLowerCase() === speaker._id.toLowerCase());
    // Host notes help an invitation or a thank-you sound like we know the place; not a chase.
    const notes =
      (kind === 'invitation' || kind === 'thank_you') && event.venueOrganisationId
        ? (
            await this.retrieval.search(event.title, {
              kind: 'host_note',
              classification: ['public'],
              limit: 5,
            })
          )
            .map((h) => h.chunk)
            .filter(
              (c) =>
                c.organisationId?.toLowerCase() === event.venueOrganisationId?.toLowerCase() ||
                c.eventId?.toLowerCase() === event._id.toLowerCase(),
            )
        : [];
    return [...abstracts.slice(0, 2), ...notes.slice(0, 2)].slice(0, this.maxChunks);
  }
}
