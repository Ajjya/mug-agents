import {
  InMemoryCandidateThreadsRepository,
  InMemoryInboundMessagesRepository,
} from '../support/in-memory.repositories.js';
import {
  candidateThreadsContract,
  inboundMessagesContract,
} from '../support/inbox-repository-contract.js';

// The same contracts run against MongoDB in test/integration/inbox-repositories.test.ts.
inboundMessagesContract(() => Promise.resolve(new InMemoryInboundMessagesRepository()));
candidateThreadsContract(() => Promise.resolve(new InMemoryCandidateThreadsRepository()));
