import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/** One real mongod for the whole run; each test file gets its own database (see mongo-test.ts). */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await MongoMemoryServer.create();
  project.provide('mongoUri', server.getUri());
  return async () => {
    await server.stop();
  };
}
