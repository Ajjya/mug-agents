import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { inject } from 'vitest';

export interface TestMongo {
  uri: string;
  dbName: string;
  client: MongoClient;
  db: Db;
  close(): Promise<void>;
}

/** Fresh, uniquely named database for one test file; dropped on close. */
export async function openTestMongo(): Promise<TestMongo> {
  const uri = inject('mongoUri');
  const dbName = `test_${randomUUID().replaceAll('-', '')}`;
  const client = await new MongoClient(uri).connect();
  const db = client.db(dbName);
  return {
    uri,
    dbName,
    client,
    db,
    close: async () => {
      await db.dropDatabase();
      await client.close();
    },
  };
}
