import { inMemorySpeakerRepos } from '../support/speakers-harness.js';
import { speakersWorkflowSuite } from '../support/speakers-workflow-suite.js';

// The same suite runs against MongoDB and the MongoDB checkpointer in test/integration.
speakersWorkflowSuite('in memory', () => Promise.resolve(inMemorySpeakerRepos()));
