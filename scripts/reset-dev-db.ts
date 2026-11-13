import { pathToFileURL } from 'node:url';
import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config/config.module.js';
import { ConfigError, type AppConfig } from '../src/config/env.schema.js';

/**
 * Operator tool: drops the configured development database so you can start from empty.
 *
 * This is deliberately NOT part of src/ and not reachable from the app or any agent: the no-delete
 * policy governs agent behaviour and domain data, not an operator's explicit reset. Guards:
 * it refuses when NODE_ENV is 'production' or when MONGODB_DB does not end in '_dev'.
 */
export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetRefusedError';
  }
}

export const DEV_DB_SUFFIX = '_dev';

export function assertResetAllowed(config: Pick<AppConfig, 'NODE_ENV' | 'MONGODB_DB'>): void {
  if (config.NODE_ENV === 'production') {
    throw new ResetRefusedError("refusing to reset: NODE_ENV is 'production'");
  }
  const name = config.MONGODB_DB;
  if (!name.endsWith(DEV_DB_SUFFIX) || name.length === DEV_DB_SUFFIX.length) {
    throw new ResetRefusedError(
      `refusing to reset: MONGODB_DB "${name}" does not end in "${DEV_DB_SUFFIX}" ` +
        `(rename your development database, e.g. "${name}${DEV_DB_SUFFIX}")`,
    );
  }
}

export interface ResetReport {
  database: string;
  collections: { name: string; documents: number }[];
  /** Graph threads that were not finished (paused for approval or stopped by a failure) and are now gone. */
  discardedThreads: string[];
}

/** Drops the configured database after the guards pass, and reports what was in it. */
export async function resetDevDb(
  client: MongoClient,
  config: Pick<AppConfig, 'NODE_ENV' | 'MONGODB_DB'>,
): Promise<ResetReport> {
  assertResetAllowed(config); // before touching the server at all
  const db = client.db(config.MONGODB_DB);
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  const collections = await Promise.all(
    infos.map(async (c) => ({
      name: c.name,
      documents: await db.collection(c.name).countDocuments(),
    })),
  );
  // Checkpoint state is part of what a reset drops: say which unfinished threads go with it, because a
  // reset during development otherwise silently discards runs that were waiting for a decision.
  const unfinished = (await db
    .collection('graph_checkpoints')
    .distinct('thread_id', { expire_at: { $exists: false } })) as string[];
  await db.dropDatabase();
  return { database: config.MONGODB_DB, collections, discardedThreads: unfinished.sort() };
}

async function main(): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  try {
    assertResetAllowed(config);
  } catch (err) {
    if (err instanceof ResetRefusedError) {
      console.error(`reset-dev-db: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const client = await new MongoClient(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  }).connect();
  try {
    const report = await resetDevDb(client, config);
    console.log(`Dropped database "${report.database}":`);
    if (report.collections.length === 0) console.log('  (it was empty or did not exist)');
    for (const c of report.collections) {
      console.log(`  ${c.name}: ${String(c.documents)} document(s)`);
    }
    if (report.discardedThreads.length > 0) {
      console.log(
        `\nWARNING: this also discarded checkpoint state for ${String(report.discardedThreads.length)} unfinished graph thread(s): paused approvals and stopped runs can no longer be resumed:`,
      );
      for (const t of report.discardedThreads) console.log(`  ${t}`);
    } else {
      console.log('\nNo unfinished graph threads were affected.');
    }
    return 0;
  } finally {
    await client.close();
  }
}

// Run only when executed directly, so tests can import the functions above.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
