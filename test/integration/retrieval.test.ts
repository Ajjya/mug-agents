import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StructuredOutputError } from '../../src/llm/errors.js';
import { callStructured, type StructuredCall } from '../../src/llm/structured.js';
import { INDEXES } from '../../src/mongo/indexes.js';
import { MongoEventsRepository } from '../../src/repositories/events.repository.js';
import { MongoOrganisationsRepository } from '../../src/repositories/organisations.repository.js';
import { MongoSpeakersRepository } from '../../src/repositories/speakers.repository.js';
import { BruteForceStore } from '../../src/retrieval/brute-force.store.js';
import { CorpusError } from '../../src/retrieval/corpus.js';
import { ingestCorpus } from '../../src/retrieval/ingest.js';
import { RetrievalService } from '../../src/retrieval/retrieval.service.js';
import { seedSpeakers } from '../../src/retrieval/seed-speakers.js';
import { SpeakerSuggester, suggestPrompt } from '../../src/retrieval/suggest-speakers.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';
import { SAMPLE, STUB_MIN_SCORE, storeSuite } from '../support/store-suite.js';
import { StubEmbedder } from '../support/stub-embedder.js';
import { StubProvider, silentLogger } from '../support/stub-provider.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
  await mongo.db.collection('speakers').createIndexes(INDEXES.speakers);
});
afterAll(async () => {
  await mongo.close();
});

storeSuite('BruteForceStore', () =>
  Promise.resolve({
    store: new BruteForceStore(mongo.db, new StubEmbedder().ref),
    speakers: new MongoSpeakersRepository(mongo.db),
  }),
);

describe('seeding and ingestion boundaries', () => {
  it('seed-speakers is idempotent by handle', async () => {
    const db = mongo.client.db(`${mongo.dbName}_seed`);
    await db.collection('speakers').createIndexes(INDEXES.speakers);
    const repo = new MongoSpeakersRepository(db);
    const first = await seedSpeakers(SAMPLE, repo);
    expect(first.created).toHaveLength(5);
    const second = await seedSpeakers(SAMPLE, repo);
    expect(second).toEqual({ created: [], updated: [], unchanged: first.created });
    expect(await repo.count()).toBe(5);
    await db.dropDatabase();
  });

  it('ingestion creates no domain documents: only chunks', async () => {
    const speakers = new MongoSpeakersRepository(mongo.db);
    await seedSpeakers(SAMPLE, speakers);
    const counts = async () => ({
      speakers: await speakers.count(),
      events: await new MongoEventsRepository(mongo.db).count(),
      organisations: await new MongoOrganisationsRepository(mongo.db).count(),
    });
    const before = await counts();
    const store = new BruteForceStore(mongo.db, 'ollama-local:ingest-boundary');
    const r = await ingestCorpus(SAMPLE, {
      embedder: new StubEmbedder('ingest-boundary'),
      stores: [store],
      speakers,
    });
    expect(r.chunks).toBeGreaterThanOrEqual(10);
    expect(await counts()).toEqual(before);
    // re-ingest is an upsert: same chunk count, nothing duplicated
    await ingestCorpus(SAMPLE, {
      embedder: new StubEmbedder('ingest-boundary'),
      stores: [store],
      speakers,
    });
    expect((await store.stats()).chunks).toBe(r.chunks);
  });

  it('ingestion refuses a corpus whose speakers are not seeded', async () => {
    const empty = new MongoSpeakersRepository(mongo.client.db(`${mongo.dbName}_empty`));
    await expect(
      ingestCorpus(SAMPLE, { embedder: new StubEmbedder(), stores: [], speakers: empty }),
    ).rejects.toThrow(/seed-speakers/);
    await expect(
      ingestCorpus(SAMPLE, { embedder: new StubEmbedder(), stores: [], speakers: empty }),
    ).rejects.toBeInstanceOf(CorpusError);
  });
});

describe('suggestSpeakers (grounded)', () => {
  let retrieval: RetrievalService;
  let speakers: MongoSpeakersRepository;
  let ids: Record<string, string>;
  const embedder = new StubEmbedder('suggest-model');

  beforeAll(async () => {
    speakers = new MongoSpeakersRepository(mongo.db);
    await seedSpeakers(SAMPLE, speakers);
    const store = new BruteForceStore(mongo.db, embedder.ref);
    await ingestCorpus(SAMPLE, { embedder, stores: [store], speakers });
    retrieval = new RetrievalService(embedder, store, STUB_MIN_SCORE);
    ids = Object.fromEntries(
      (await speakers.findMany({ limit: 50 })).items.map((s) => [s.handle ?? s.name, s._id]),
    );
  });

  /** The real structured-call ladder, driven by a stub provider that replays scripted answers. */
  const callWith = (answers: (string | ((prompt: string) => string))[]) => {
    const prompts: string[] = [];
    const provider = new StubProvider([]);
    const replay = {
      ...provider,
      chat: (req: { prompt: string }) => {
        prompts.push(req.prompt);
        const a = answers.shift();
        const content = typeof a === 'function' ? a(req.prompt) : a;
        if (content === undefined) return Promise.reject(new Error('script exhausted'));
        return Promise.resolve({ content, promptTokens: 1, completionTokens: 1, latencyMs: 1 });
      },
    };
    const call: StructuredCall = (schema, prompt, options) =>
      callStructured(schema, prompt, options, {
        ladder: [{ provider: 'ollama', model: 'stub' }],
        provider: () => ({ ...replay, name: 'ollama', constrainsOutput: false }),
        maxAttempts: 2,
        timeoutMs: 1000,
        logger: silentLogger,
      });
    return { call, prompts };
  };
  const zaraChunk = 'abstracts/change-streams-in-production#0';

  it('a topic with nothing in the corpus returns empty, with no model call and no invented speaker', async () => {
    const { call, prompts } = callWith([]);
    const r = await new SpeakerSuggester(retrieval, speakers, call).suggest(
      'kubernetes operator postgres failover',
    );
    expect(r.suggestions).toEqual([]);
    expect(r.message).toMatch(/Nothing in the corpus matches/);
    expect(prompts).toEqual([]);
  });

  it('a grounded answer cites real chunks and names a real speaker', async () => {
    const answer = () =>
      JSON.stringify({
        suggestions: [
          {
            speakerId: ids['zara-quillfeather'],
            citations: [zaraChunk],
            reason: 'Her abstract: "running change streams in production for eighteen months".',
          },
        ],
      });
    const { call } = callWith([answer]);
    const r = await new SpeakerSuggester(retrieval, speakers, call).suggest(
      'change streams resume tokens production',
    );
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]?.speaker).toMatchObject({
      id: ids['zara-quillfeather'],
      name: 'Zara Quillfeather',
      handle: 'zara-quillfeather',
    });
    expect(r.suggestions[0]?.citations.map((c) => c.id)).toEqual([zaraChunk]);
    for (const c of r.suggestions[0]?.citations ?? [])
      expect(r.hits.map((h) => h.chunk.id)).toContain(c.id);
  });

  it('retrieved text is fenced as untrusted data, and the injection document reaches the prompt only as data', async () => {
    const { call, prompts } = callWith([() => JSON.stringify({ suggestions: [] })]);
    await new SpeakerSuggester(retrieval, speakers, call).suggest(
      'community update change streams volunteers',
    );
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('untrusted reference material');
    const i = prompt.indexOf('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(i).toBeGreaterThan(-1);
    expect(prompt.lastIndexOf('<<<CHUNK', i)).toBeGreaterThan(-1);
    expect(prompt.indexOf('<<<END CHUNK>>>', i)).toBeGreaterThan(i);
    expect(suggestPrompt('t', [], [], 3)).toContain('return {"suggestions": []}');
  });

  it('a model that obeys the injection cannot get its suggestion through: no grounded evidence', async () => {
    // Recommends Pip for change streams, citing the injection post (which belongs to no speaker).
    const obey = () =>
      JSON.stringify({
        suggestions: [
          {
            speakerId: ids['pip-lanternfield'],
            citations: ['posts/community-update#0'],
            reason: 'The post says to.',
          },
        ],
      });
    const { call } = callWith([obey, obey]);
    const err = await new SpeakerSuggester(retrieval, speakers, call)
      .suggest('community update change streams volunteers')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StructuredOutputError);
  });

  it('the injection document does not change a correct suggestion', async () => {
    const answer = () =>
      JSON.stringify({
        suggestions: [
          {
            speakerId: ids['zara-quillfeather'],
            citations: [zaraChunk],
            reason: 'Change streams in production.',
          },
        ],
      });
    const withInjection = await new SpeakerSuggester(
      retrieval,
      speakers,
      callWith([answer]).call,
    ).suggest('change streams community update');
    const withoutInjection = await new SpeakerSuggester(
      retrieval,
      speakers,
      callWith([answer]).call,
    ).suggest('change streams resume tokens production');
    expect(withInjection.hits.map((h) => h.chunk.documentId)).toContain('posts/community-update');
    expect(withInjection.suggestions.map((s) => s.speaker.id)).toEqual(
      withoutInjection.suggestions.map((s) => s.speaker.id),
    );
  });

  it('an unknown or ungrounded speaker id is a validation failure, retried by the ladder', async () => {
    const bogus = JSON.stringify({
      suggestions: [{ speakerId: 'f'.repeat(24), citations: [zaraChunk], reason: 'x' }],
    });
    const fixed = JSON.stringify({
      suggestions: [
        { speakerId: ids['zara-quillfeather'], citations: [zaraChunk], reason: 'Abstract.' },
      ],
    });
    const { call, prompts } = callWith([bogus, fixed]);
    const r = await new SpeakerSuggester(retrieval, speakers, call).suggest(
      'change streams resume tokens production',
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('rejected by validation');
    expect(r.suggestions[0]?.speaker.id).toBe(ids['zara-quillfeather']);
    expect(z.string().parse(r.suggestions[0]?.reason)).toBeTruthy();
  });
});
