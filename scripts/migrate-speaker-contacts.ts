import type { Db } from 'mongodb';
import { migrateSpeakerContacts } from '../src/mongo/migrate-speaker-contacts.js';
import { MONGO_DB } from '../src/mongo/tokens.js';
import { runCli } from './cli.js';

/**
 * One-off, idempotent: see {@link migrateSpeakerContacts}. Run it BEFORE anything else reads speakers: the
 * speaker schema no longer accepts `links.linkedin` (a LinkedIn URL lives in `handles.linkedin`).
 */
runCli(async (app) => {
  const db = app.get<Db>(MONGO_DB, { strict: false });
  const r = await migrateSpeakerContacts(db.collection('speakers'));
  console.log(
    `Speakers: ${String(r.emailsMoved)} had an email moved to emails; ${String(r.emailsFilled)} given emails []; ${String(r.handlesFilled)} given handles {}; old email index ${r.oldEmailIndexDropped ? 'dropped' : 'was not present'}.`,
  );
  console.log(
    `LinkedIn: ${String(r.linkedinMoved)} moved from links.linkedin to handles.linkedin; ${String(r.linkedinDuplicatesDropped)} already had handles.linkedin (left alone, the old field removed).`,
  );
  return 0;
});
