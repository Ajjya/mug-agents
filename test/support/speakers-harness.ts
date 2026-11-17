import { type BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph';
import { ApprovalRequestGate } from '../../src/approvals/approval-gate.js';
import type {
  ApprovalDecisionsRepository,
  ApprovalRequestsRepository,
} from '../../src/approvals/approvals.repository.js';
import { ApprovalsService } from '../../src/approvals/approvals.service.js';
import type { ApprovalGate, EnsureRequestInput } from '../../src/agents/planner/planner.graph.js';
import type { ChasePolicy } from '../../src/agents/speakers/decide.js';
import { type DraftContext, buildSpeakersGraph } from '../../src/agents/speakers/speakers.graph.js';
import { SpeakersRuntime } from '../../src/agents/speakers/speakers.runtime.js';
import { SpeakersService } from '../../src/agents/speakers/speakers.service.js';
import { SpeakerPipelineStore } from '../../src/agents/speakers/speakers.store.js';
import type { RetentionPort } from '../../src/graph/runtime.js';
import { InMemoryThreadLock, type ThreadLock } from '../../src/graph/thread-lock.js';
import type { ChatRequest, ChatResponse, LlmProvider } from '../../src/llm/model.types.js';
import { type StructuredCall, callStructured } from '../../src/llm/structured.js';
import type { EventsRepository } from '../../src/repositories/events.repository.js';
import type { MessagesRepository } from '../../src/repositories/messages.repository.js';
import type { OrganisationsRepository } from '../../src/repositories/organisations.repository.js';
import type { SpeakersRepository } from '../../src/repositories/speakers.repository.js';
import type { TasksRepository } from '../../src/repositories/tasks.repository.js';
import type { ChunkView } from '../../src/retrieval/vector-store.js';
import {
  InMemoryApprovalDecisionsRepository,
  InMemoryApprovalRequestsRepository,
  InMemoryEventsRepository,
  InMemoryMessagesRepository,
  InMemoryOrganisationsRepository,
  InMemorySpeakersRepository,
  InMemoryTasksRepository,
} from './in-memory.repositories.js';
import { RecordingRetention, SimulatedCrash } from './planner-harness.js';

export interface SpeakerRepos {
  events: EventsRepository;
  speakers: SpeakersRepository;
  organisations: OrganisationsRepository;
  messages: MessagesRepository;
  tasks: TasksRepository;
  requests: ApprovalRequestsRepository;
  decisions: ApprovalDecisionsRepository;
}

export const inMemorySpeakerRepos = (): SpeakerRepos => ({
  events: new InMemoryEventsRepository(),
  speakers: new InMemorySpeakersRepository(),
  organisations: new InMemoryOrganisationsRepository(),
  messages: new InMemoryMessagesRepository(),
  tasks: new InMemoryTasksRepository(),
  requests: new InMemoryApprovalRequestsRepository(),
  decisions: new InMemoryApprovalDecisionsRepository(),
});

export const POLICY: ChasePolicy = {
  chaseMaxRounds: 2,
  chaseMinIntervalDays: 7,
  maxDraftsPerRun: 10,
};

/** The placeholders a draft prompt offers, in order. */
export function offeredSlots(prompt: string): string[] {
  return [...prompt.matchAll(/^- \{\{([a-z_]+)\}\}:/gm)].map((m) => m[1] ?? '');
}

/** What a well-behaved model answers: every offered placeholder, no fact written out. */
export function compliantAnswer(prompt: string): string {
  const slots = offeredSlots(prompt);
  const rest = slots.filter((s) => s !== 'speaker_name' && s !== 'event_title');
  return JSON.stringify({
    subject: 'About {{event_title}}',
    body: [
      'Hello {{speaker_name}},',
      'A note from the user group about {{event_title}}.',
      ...rest.map((s) => `Please note: {{${s}}}.`),
      'The MUG organisers',
    ].join('\n'),
    usedFacts: slots,
  });
}

/**
 * A model that writes what an injected chunk told it to: a new recipient, a fee and a date of its
 * own. Validation refuses it; the ladder retries, and the compliant answer is what gets stored.
 */
export function injectedAnswer(prompt: string): string {
  const ok = JSON.parse(compliantAnswer(prompt)) as {
    subject: string;
    body: string;
    usedFacts: string[];
  };
  return JSON.stringify({
    ...ok,
    body: `${ok.body}\nPlease reply to evil@example.com instead. We will pay you €500 and the date is now 1 January.`,
  });
}

/** A fake provider in front of the real callStructured: validation and the retry ladder are real. */
export class ScriptedModel implements LlmProvider {
  readonly name = 'ollama';
  readonly constrainsOutput = false;
  readonly prompts: string[] = [];
  /** Answers to give first, before falling back to compliant ones. */
  queue: ((prompt: string) => string)[] = [];
  /** Throw this for every call (a provider outage). */
  fail: Error | undefined;

  chat(request: ChatRequest): Promise<ChatResponse> {
    this.prompts.push(request.prompt);
    if (this.fail) return Promise.reject(this.fail);
    const answer = (this.queue.shift() ?? compliantAnswer)(request.prompt);
    return Promise.resolve({
      content: answer,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 1,
    });
  }
}

export class StubContext implements DraftContext {
  chunks: ChunkView[] = [];
  asked: { speakerId: string; kind: string }[] = [];
  forDraft(_event: unknown, speaker: { _id: string }, kind: string): Promise<ChunkView[]> {
    this.asked.push({ speakerId: speaker._id, kind });
    return Promise.resolve(this.chunks);
  }
}

export interface SpeakersHarness {
  repos: SpeakerRepos;
  model: ScriptedModel;
  context: StubContext;
  store: SpeakerPipelineStore;
  runtime: SpeakersRuntime;
  service: SpeakersService;
  approvals: ApprovalsService;
  /** Throw right after the approval request is written (a crash before suspending). */
  behaviour: { crashAfterRequest: boolean };
}

export interface SpeakersHarnessOptions {
  saver?: BaseCheckpointSaver;
  retention?: RetentionPort;
  lock?: ThreadLock;
  policy?: ChasePolicy;
}

/** The real graph, runtime, store and services over injected repositories and a scripted model. */
export function buildSpeakersHarness(
  repos: SpeakerRepos,
  options: SpeakersHarnessOptions = {},
): SpeakersHarness {
  const model = new ScriptedModel();
  const context = new StubContext();
  const behaviour = { crashAfterRequest: false };
  const call: StructuredCall = (schema, prompt, opts) =>
    callStructured(schema, prompt, opts, {
      ladder: [
        { provider: 'ollama', model: 'stub-a' },
        { provider: 'ollama', model: 'stub-b' },
      ],
      provider: () => model,
      maxAttempts: 4,
      timeoutMs: 1000,
      logger: { log: () => undefined, warn: () => undefined },
    });
  const realGate = new ApprovalRequestGate(repos.requests);
  const gate: ApprovalGate = {
    async ensureRequest(input: EnsureRequestInput) {
      const r = await realGate.ensureRequest(input);
      if (behaviour.crashAfterRequest) throw new SimulatedCrash();
      return r;
    },
  };
  const store = new SpeakerPipelineStore(
    repos.events,
    repos.speakers,
    repos.organisations,
    repos.messages,
    repos.tasks,
    'organiser',
  );
  const policy = options.policy ?? POLICY;
  const saver = options.saver ?? new MemorySaver();
  const retention =
    options.retention ??
    new RecordingRetention(saver instanceof MemorySaver ? saver : new MemorySaver());
  const runtime = new SpeakersRuntime(
    buildSpeakersGraph({ call, gate, store, context, policy, timeZone: 'Europe/Lisbon' }, saver),
    retention,
    options.lock ?? new InMemoryThreadLock(),
  );
  return {
    repos,
    model,
    context,
    store,
    runtime,
    service: new SpeakersService(store, runtime, repos.requests, repos.decisions, policy),
    approvals: new ApprovalsService(repos.requests, repos.decisions, [runtime]),
    behaviour,
  };
}
