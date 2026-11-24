import type { Db } from 'mongodb';
import { MONGO_DB } from '../src/mongo/tokens.js';
import { runCli } from './cli.js';

/**
 * One-off, idempotent: speakers used to carry one optional `email`; they now carry `emails: string[]` and
 * `handles: {}`. Moves each stored `email` into `emails`, gives every other speaker `emails: []` and
 * `handles: {}`, and drops the old unique index (the new `speakers_emails_unique` is created at startup).
 * Nothing else is touched, and nothing is deleted except that index.
 */
runCli(async (app) => {
  const db = app.get<Db>(MONGO_DB, { strict: false });
  const col = db.collection('speakers');
  const moved = await col.updateMany({ email: { $exists: true } }, [
    {
      $set: {
        emails: {
          $cond: [{ $isArray: '$emails' }, '$emails', ['$email']],
        },
        handles: { $ifNull: ['$handles', {}] },
      },
    },
    { $unset: 'email' },
  ]);
  const filled = await col.updateMany({ emails: { $exists: false } }, [
    { $set: { emails: [], handles: { $ifNull: ['$handles', {}] } } },
  ]);
  const handles = await col.updateMany({ handles: { $exists: false } }, [
    { $set: { handles: {} } },
  ]);
  const hadOldIndex = (await col.indexes()).some((i) => i.name === 'speakers_email_unique');
  if (hadOldIndex) await col.dropIndex('speakers_email_unique');
  console.log(
    `Speakers: ${String(moved.modifiedCount)} had an email moved to emails; ${String(filled.modifiedCount)} given emails []; ${String(handles.modifiedCount)} given handles {}; old email index ${hadOldIndex ? 'dropped' : 'was not present'}.`,
  );
  return 0;
});
