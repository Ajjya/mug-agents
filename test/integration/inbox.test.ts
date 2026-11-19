import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, ConfigModule } from '../../src/config/config.module.js';
import { ConfigError, type AppConfig, parseEnv } from '../../src/config/env.schema.js';
import { GMAIL_CLIENT, INBOX_CONFIG, InboxModule } from '../../src/inbox/inbox.module.js';
import { InboxService } from '../../src/inbox/inbox.service.js';
import {
  INBOUND_MESSAGES_REPOSITORY,
  type InboundMessagesRepository,
} from '../../src/inbox/repositories.js';
import { STRUCTURED_CALL, LlmModule } from '../../src/llm/llm.module.js';
import type { StructuredCall } from '../../src/llm/structured.js';
import { AppLogger, LoggerModule } from '../../src/logging/logger.module.js';
import { MongoModule } from '../../src/mongo/mongo.module.js';
import {
  EVENTS_REPOSITORY,
  type EventsRepository,
} from '../../src/repositories/events.repository.js';
import { RepositoriesModule } from '../../src/repositories/repositories.module.js';
import {
  SPEAKERS_REPOSITORY,
  type SpeakersRepository,
} from '../../src/repositories/speakers.repository.js';
import { FakeGmail } from '../support/fake-gmail.js';
import { NEUTRAL_ANSWER } from '../support/inbox-harness.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

const cfg = (over: Record<string, string> = {}): AppConfig =>
  parseEnv({
    NODE_ENV: 'test',
    MONGODB_URI: mongo.uri,
    MONGODB_DB: mongo.dbName,
    LOG_LEVEL: 'silent',
    ...over,
  });

async function boot(config: AppConfig, gmail = FakeGmail.fromFixture()) {
  const prompts: string[] = [];
  const call: StructuredCall = (schema, prompt) => {
    prompts.push(prompt);
    return Promise.resolve({
      value: schema.parse(JSON.parse(NEUTRAL_ANSWER)),
      calls: [],
      model: { provider: 'ollama', model: 'stub' },
    });
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forValue(config),
      LoggerModule.forValue(new AppLogger(config)),
      LlmModule.register(),
      MongoModule,
      RepositoriesModule,
      InboxModule,
    ],
  })
    .overrideProvider(STRUCTURED_CALL)
    .useValue(call)
    .overrideProvider(GMAIL_CLIENT)
    .useValue(gmail)
    .compile();
  const app: INestApplicationContext = await moduleRef.init();
  return { app, gmail, prompts };
}

describe('the inbox module validates its configuration at boot (spec 1.4)', () => {
  it('unset labels fail to boot, naming both', async () => {
    const err = await boot(cfg()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems.join('\n')).toMatch(
      /GMAIL_LABEL[\s\S]*GMAIL_CANDIDATE_LABEL/,
    );
  });

  it('equal labels fail to boot', async () => {
    const err = await boot(cfg({ GMAIL_LABEL: 'mug', GMAIL_CANDIDATE_LABEL: 'MUG' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems.join()).toMatch(/must differ/);
  });

  it('valid labels boot, and Gmail credentials are NOT needed to boot', async () => {
    const { app } = await boot(
      cfg({ GMAIL_LABEL: 'mug-agents', GMAIL_CANDIDATE_LABEL: 'mug-maybe' }),
    );
    expect(app.get(INBOX_CONFIG)).toMatchObject({
      label: 'mug-agents',
      candidateLabel: 'mug-maybe',
    });
    expect(app.get<AppConfig>(APP_CONFIG).IMAP_APP_PASSWORD).toBeUndefined();
    await app.close();
  });
});

describe('poll -> store -> triage -> link on MongoDB, with a fake Gmail and a stub model', () => {
  it('stores, links, sets lastInboundAt, keeps the body behind getRawBody, and a second poll adds nothing', async () => {
    const { app, gmail, prompts } = await boot(
      cfg({ GMAIL_LABEL: 'mug-agents', GMAIL_CANDIDATE_LABEL: 'mug-maybe' }),
    );
    const speakers = app.get<SpeakersRepository>(SPEAKERS_REPOSITORY);
    const events = app.get<EventsRepository>(EVENTS_REPOSITORY);
    const inbound = app.get<InboundMessagesRepository>(INBOUND_MESSAGES_REPOSITORY);
    const event = await events.insert({
      title: 'MUG Sample City Winter Meetup',
      phase: 'planning',
      date: '2026-12-12T00:00:00.000Z',
      coHostOrganisationIds: [],
      agenda: [],
    });
    const w = await speakers.insert({
      name: 'Wendeline Gooseberry',
      email: 'wendeline@speakers.invalid',
      topics: [],
      links: {},
      perEvent: [{ eventId: event._id, status: 'invited', updatedAt: '2026-10-01T00:00:00.000Z' }],
    });

    const inbox = app.get(InboxService);
    const first = await inbox.poll({ now: new Date('2026-11-01T12:00:00.000Z') });
    expect([...first.stored].sort()).toEqual(['m-001', 'm-005', 'm-006']);
    expect(first.triaged).toBe(3);
    // The scope guarantee, on the real thing: counted at the transport and at the model.
    expect([...gmail.calls.full].sort()).toEqual(['m-001', 'm-005', 'm-006']);
    expect(prompts).toHaveLength(3);
    expect(prompts.join()).not.toMatch(/PRIVATE-MARKER|CANDIDATE-BODY-MARKER/);

    const m1 = await inbound.findByGmailId('m-001');
    expect(m1).toMatchObject({
      linkState: 'auto',
      linkedSpeakerId: w._id,
      linkedEventId: event._id,
      triageState: 'done',
    });
    expect(m1).not.toHaveProperty('bodyText');
    expect(await inbound.getRawBody(m1?._id ?? '')).toContain('I would love to speak'); // through the one door
    const after = await speakers.findById(w._id);
    expect(after?.perEvent[0]).toMatchObject({
      status: 'invited',
      lastInboundAt: '2026-10-27T09:30:00.000Z',
    });
    expect(after?.name).toBe(w.name);

    // A second poll over the same mailbox: nothing duplicated, no body fetched, no model call (unique gmailId).
    const full = [...gmail.calls.full];
    const second = await inbox.poll({ now: new Date('2026-11-01T12:00:00.000Z') });
    expect(second.stored).toEqual([]);
    expect(gmail.calls.full).toEqual(full);
    expect(prompts).toHaveLength(3);
    expect(await inbound.count()).toBe(3);
    await app.close();
  });
});
