import type { Event } from '../../domain/event.schema.js';
import type { MessageKind } from '../../domain/message.schema.js';
import type { Speaker } from '../../domain/speaker.schema.js';
import { EmbeddingUnavailableError } from '../../retrieval/embedder.js';
import type { RetrievalService, SearchOptions } from '../../retrieval/retrieval.service.js';
import type { ChunkView } from '../../retrieval/vector-store.js';
import type { DraftContext } from './speakers.graph.js';

/**
 * How many ranked chunks are filtered down to this speaker's (or this venue's). The stores already
 * rank at least 50 candidates per arm, so asking for 50 costs nothing extra; a top-8 cut missed a
 * speaker's own abstract that ranked lower on the event's theme.
 */
const CANDIDATES = 50;

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

  /**
   * Hybrid search, or keyword-only when the local embedder is not running: the context only sets the
   * tone, so a draft is not worth failing a run over it.
   */
  private async search(text: string, options: SearchOptions): Promise<ChunkView[]> {
    try {
      return (await this.retrieval.search(text, options)).map((h) => h.chunk);
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err;
      return (await this.retrieval.search(text, { ...options, strategy: 'keyword' })).map(
        (h) => h.chunk,
      );
    }
  }

  async forDraft(event: Event, speaker: Speaker, kind: MessageKind): Promise<ChunkView[]> {
    const topic = [event.theme ?? event.title, ...speaker.topics].join(' ');
    const abstracts = (
      await this.search(topic, {
        kind: 'abstract',
        classification: ['public'],
        limit: CANDIDATES,
      })
    ).filter((c) => c.speakerId?.toLowerCase() === speaker._id.toLowerCase());
    // Host notes help an invitation or a thank-you sound like we know the place; not a chase.
    const notes =
      (kind === 'invitation' || kind === 'thank_you') && event.venueOrganisationId
        ? (
            await this.search(event.title, {
              kind: 'host_note',
              classification: ['public'],
              limit: CANDIDATES,
            })
          ).filter(
            (c) =>
              c.organisationId?.toLowerCase() === event.venueOrganisationId?.toLowerCase() ||
              c.eventId?.toLowerCase() === event._id.toLowerCase(),
          )
        : [];
    return [...abstracts.slice(0, 2), ...notes.slice(0, 2)].slice(0, this.maxChunks);
  }
}
