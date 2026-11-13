import { Module } from '@nestjs/common';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import type { Db, MongoClient } from 'mongodb';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { MONGO_CLIENT, MONGO_DB } from '../mongo/tokens.js';
import { CheckpointRetention } from './retention.js';

export const CHECKPOINTER = Symbol('CHECKPOINTER');
export const CHECKPOINT_RETENTION = Symbol('CHECKPOINT_RETENTION');

type SaverClient = ConstructorParameters<typeof MongoDBSaver>[0]['client'];

/**
 * Builds the official MongoDB checkpointer on the application's existing MongoClient: one
 * connection pool, one failure domain, no second client.
 *
 * Collections: `graph_checkpoints` and `graph_checkpoint_writes` (the package's defaults are the
 * generic `checkpoints` / `checkpoint_writes`; the prefix keeps operational data visibly apart
 * from domain collections). Indexes are NOT created here: they are declared in
 * src/mongo/indexes.ts and created by ensureIndexes() at startup, so `saver.setup()` is not called.
 */
export function createCheckpointer(client: MongoClient, db: Db): MongoDBSaver {
  return new MongoDBSaver({
    // The package bundles its own mongodb@6 typings; this application uses driver 7. The saver only
    // calls client.db() and plain collection operations, which are identical (verified end to end in
    // test/integration). The cast is the single place the two driver versions meet.
    client: client as unknown as SaverClient,
    dbName: db.databaseName,
    checkpointCollectionName: COLLECTIONS.graphCheckpoints,
    checkpointWritesCollectionName: COLLECTIONS.graphCheckpointWrites,
    // upserted_at on every write: useful for audit and debugging. Expiry does NOT use it.
    enableTimestamps: true,
  });
}

@Module({
  imports: [MongoModule],
  providers: [
    {
      provide: CHECKPOINTER,
      inject: [MONGO_CLIENT, MONGO_DB],
      useFactory: (client: MongoClient, db: Db) => createCheckpointer(client, db),
    },
    {
      provide: CHECKPOINT_RETENTION,
      inject: [MONGO_DB, APP_CONFIG],
      useFactory: (db: Db, config: AppConfig) =>
        new CheckpointRetention(db, config.CHECKPOINT_TTL_DAYS),
    },
  ],
  exports: [CHECKPOINTER, CHECKPOINT_RETENTION],
})
export class CheckpointerModule {}
