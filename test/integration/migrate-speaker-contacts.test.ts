import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chooseDelivery } from '../../src/agents/speakers/delivery.js';
import { SpeakerInputSchema } from '../../src/domain/speaker.schema.js';
import { migrateSpeakerContacts } from '../../src/mongo/migrate-speaker-contacts.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

const base = { topics: [], perEvent: [], createdAt: '2026-01-01T00:00:00.000Z', version: 1 };

describe('speaker contact migration: a LinkedIn URL has one home, handles.linkedin', () => {
  it('moves links.linkedin into handles when handles has none, leaves an existing handle alone, unsets the old field, and reports', async () => {
    const col = mongo.db.collection('speakers');
    await col.insertMany([
      // seeded the old way: LinkedIn only in links, and the old single `email`
      {
        ...base,
        name: 'Only In Links',
        email: 'a@x.invalid',
        links: { linkedin: 'https://linkedin.com/in/a', github: 'https://github.com/a' },
      },
      // both: the handle is the human's and must not be touched
      {
        ...base,
        name: 'Both',
        emails: [],
        handles: { linkedin: 'https://linkedin.com/in/b-handle' },
        links: { linkedin: 'https://linkedin.com/in/b-links' },
      },
      // other handles present, none for linkedin: kept
      {
        ...base,
        name: 'Has Whatsapp',
        emails: [],
        handles: { whatsapp: '+351000' },
        links: { linkedin: 'https://linkedin.com/in/c' },
      },
      // nothing to move
      { ...base, name: 'Clean', emails: [], handles: {}, links: { website: 'https://c.invalid' } },
    ]);

    const first = await migrateSpeakerContacts(col);
    expect(first).toMatchObject({ linkedinMoved: 2, linkedinDuplicatesDropped: 1, emailsMoved: 1 });

    const by = async (name: string) => await col.findOne({ name });
    expect((await by('Only In Links'))?.['handles']).toEqual({
      linkedin: 'https://linkedin.com/in/a',
    });
    expect((await by('Only In Links'))?.['links']).toEqual({ github: 'https://github.com/a' });
    expect((await by('Only In Links'))?.['emails']).toEqual(['a@x.invalid']);
    expect((await by('Both'))?.['handles']).toEqual({
      linkedin: 'https://linkedin.com/in/b-handle',
    });
    expect((await by('Both'))?.['links']).toEqual({});
    expect((await by('Has Whatsapp'))?.['handles']).toEqual({
      whatsapp: '+351000',
      linkedin: 'https://linkedin.com/in/c',
    });
    expect((await by('Clean'))?.['links']).toEqual({ website: 'https://c.invalid' });

    // After migration the speaker is reachable: the old document parses, and chooseDelivery sees the handle.
    const { _id, createdAt, version, ...stored } = ((await by('Has Whatsapp')) ?? {}) as Record<
      string,
      unknown
    >;
    void [_id, createdAt, version];
    const migrated = SpeakerInputSchema.parse(stored);
    expect(chooseDelivery(migrated)).toBe('manual:linkedin');
  });

  it('is idempotent: a second run changes and reports nothing', async () => {
    const col = mongo.db.collection('speakers');
    const before = JSON.stringify(await col.find().sort({ name: 1 }).toArray());
    const again = await migrateSpeakerContacts(col);
    expect(again).toMatchObject({
      linkedinMoved: 0,
      linkedinDuplicatesDropped: 0,
      emailsMoved: 0,
      emailsFilled: 0,
      handlesFilled: 0,
    });
    expect(JSON.stringify(await col.find().sort({ name: 1 }).toArray())).toBe(before);
  });
});
