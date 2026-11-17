import { describe, expect, it } from 'vitest';
import { RetrievalDraftContext } from '../../src/agents/speakers/retrieval-context.js';
import type { Event } from '../../src/domain/event.schema.js';
import type { Speaker } from '../../src/domain/speaker.schema.js';
import type { RetrievalService, SearchOptions } from '../../src/retrieval/retrieval.service.js';
import type { ChunkView, Hit } from '../../src/retrieval/vector-store.js';
import { EmbeddingUnavailableError } from '../../src/retrieval/embedder.js';

const SPEAKER = { _id: 'd'.repeat(24), name: 'W', topics: ['validation'] } as Speaker;
const VENUE = 'b'.repeat(24);
const EVENT = { _id: 'a'.repeat(24), title: 'Winter Meetup', venueOrganisationId: VENUE } as Event;

const chunk = (id: string, over: Partial<ChunkView>): Hit => ({
  score: 1,
  chunk: {
    id,
    documentId: id,
    index: 0,
    heading: '',
    text: id,
    kind: 'abstract',
    classification: 'public',
    date: '2026-01-01',
    embedder: 'e',
    model: 'm',
    dim: 1,
    ...over,
  },
});

function stub() {
  const asked: SearchOptions[] = [];
  const retrieval = {
    search: (_text: string, o: SearchOptions = {}) => {
      asked.push(o);
      return Promise.resolve(
        o.kind === 'abstract'
          ? [
              chunk('mine', { speakerId: SPEAKER._id }),
              chunk('someone-else', { speakerId: 'e'.repeat(24) }),
            ]
          : [
              chunk('our-venue', { kind: 'host_note', organisationId: VENUE }),
              chunk('other-venue', { kind: 'host_note', organisationId: 'c'.repeat(24) }),
            ],
      );
    },
  } as unknown as RetrievalService;
  return { asked, ctx: new RetrievalDraftContext(retrieval) };
}

describe('RetrievalDraftContext', () => {
  it('falls back to keyword search when the local embedder is down', async () => {
    const strategies: (string | undefined)[] = [];
    const retrieval = {
      search: (_t: string, o: SearchOptions = {}) => {
        strategies.push(o.strategy);
        if (o.strategy !== 'keyword')
          return Promise.reject(new EmbeddingUnavailableError('local embedder down'));
        return Promise.resolve([chunk('mine', { speakerId: SPEAKER._id })]);
      },
    } as unknown as RetrievalService;
    const ids = (
      await new RetrievalDraftContext(retrieval).forDraft(EVENT, SPEAKER, 'chase_bio')
    ).map((c) => c.id);
    expect(ids).toEqual(['mine']);
    expect(strategies).toEqual([undefined, 'keyword']);
  });

  it("an invitation gets the speaker's own abstracts and this venue's host notes, public only", async () => {
    const { asked, ctx } = stub();
    const chunks = await ctx.forDraft(EVENT, SPEAKER, 'invitation');
    expect(chunks.map((c) => c.id)).toEqual(['mine', 'our-venue']);
    expect(asked.every((o) => o.classification?.join() === 'public')).toBe(true);
  });

  it("finds the speaker's own abstract even when 14 others rank above it (review finding 16)", async () => {
    const ranked = [
      ...Array.from({ length: 14 }, (_, i) =>
        chunk(`other-${String(i)}`, { speakerId: 'e'.repeat(24) }),
      ),
      chunk('mine-rank-15', { speakerId: SPEAKER._id }),
    ];
    const retrieval = {
      search: (_t: string, o: SearchOptions = {}) => Promise.resolve(ranked.slice(0, o.limit ?? 5)),
    } as unknown as RetrievalService;
    const ids = (
      await new RetrievalDraftContext(retrieval).forDraft(EVENT, SPEAKER, 'chase_bio')
    ).map((c) => c.id);
    expect(ids).toEqual(['mine-rank-15']);
  });

  it('a chase gets no host notes', async () => {
    const { asked, ctx } = stub();
    expect((await ctx.forDraft(EVENT, SPEAKER, 'chase_slides')).map((c) => c.id)).toEqual(['mine']);
    expect(asked.map((o) => o.kind)).toEqual(['abstract']);
  });
});
