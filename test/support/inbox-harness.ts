import type { ChatRequest, ChatResponse, LlmProvider } from '../../src/llm/model.types.js';
import { type StructuredCall, callStructured } from '../../src/llm/structured.js';
import type { InboxConfig } from '../../src/inbox/inbox.config.js';
import { InboxService, type InboxDeps } from '../../src/inbox/inbox.service.js';
import { Triager } from '../../src/inbox/triage.js';
import type { EventsRepository } from '../../src/repositories/events.repository.js';
import type { OrganisationsRepository } from '../../src/repositories/organisations.repository.js';
import type { SpeakersRepository } from '../../src/repositories/speakers.repository.js';
import type { TasksRepository } from '../../src/repositories/tasks.repository.js';
import type { GmailClient } from '../../src/inbox/gmail.transport.js';
import { FakeGmail } from './fake-gmail.js';
import {
  InMemoryAdmittedThreadsRepository,
  InMemoryCandidateThreadsRepository,
  InMemoryContactsRepository,
  InMemoryEventsRepository,
  InMemoryExcludedThreadsRepository,
  InMemoryInboundMessagesRepository,
  InMemoryInboxCursorRepository,
  InMemoryOrganisationsRepository,
  InMemorySpeakersRepository,
  InMemoryTasksRepository,
} from './in-memory.repositories.js';

/** What a well-behaved model answers for most mail: a valid summary that claims nothing. */
export const NEUTRAL_ANSWER = JSON.stringify({
  intent: 'other',
  sentiment_decision: 'unclear',
  mentions: { dates: [], people: [], organisations: [] },
  materials: { abstract: false, bio: false, photo: false, slides: false },
  asks: [],
  needs_human: false,
  reason: '',
  confidence: 'medium',
});

/**
 * A provider that COUNTS: every call is a mail body (or its redaction) leaving the machine, so a test
 * asserts how many calls there were and exactly what text each carried.
 */
export class RecordingModel implements LlmProvider {
  readonly name = 'ollama';
  readonly constrainsOutput = false;
  readonly prompts: string[] = [];
  /** Answers to give first, in order; then the neutral answer. */
  queue: ((prompt: string) => string)[] = [];
  /** Throw this for every call (a provider outage). */
  fail: Error | undefined;

  get calls(): number {
    return this.prompts.length;
  }

  chat(request: ChatRequest): Promise<ChatResponse> {
    this.prompts.push(request.prompt);
    if (this.fail) return Promise.reject(this.fail);
    const content = (this.queue.shift() ?? (() => NEUTRAL_ANSWER))(request.prompt);
    return Promise.resolve({ content, promptTokens: 10, completionTokens: 5, latencyMs: 1 });
  }
}

export const TEST_INBOX_CONFIG: InboxConfig = {
  label: 'mug-agents',
  candidateLabel: 'mug-maybe',
  triageStartRung: 0,
  triageMaxChars: 6000,
  sweepMaxPages: 20,
  sweepPageSize: 200,
};

export interface InboxHarness {
  gmail: FakeGmail;
  model: RecordingModel;
  repos: {
    inbound: InMemoryInboundMessagesRepository;
    admitted: InMemoryAdmittedThreadsRepository;
    excluded: InMemoryExcludedThreadsRepository;
    candidates: InMemoryCandidateThreadsRepository;
    contacts: InMemoryContactsRepository;
    cursor: InMemoryInboxCursorRepository;
    speakers: SpeakersRepository;
    events: EventsRepository;
    organisations: OrganisationsRepository;
    tasks: TasksRepository;
  };
  service: InboxService;
  /** Everything the service logged, flattened to one string per line. */
  logs: string[];
  config: InboxConfig;
}

export interface InboxHarnessOptions {
  gmail?: FakeGmail;
  /** A different client for the service to use (the real adapter over a stub API), while `gmail` stays the lever-bearing fake. */
  client?: GmailClient;
  config?: Partial<InboxConfig>;
  /** Repositories shared with another harness (the Speakers agent's), so a reply the inbox links is seen by it. */
  shared?: {
    speakers: SpeakersRepository;
    events: EventsRepository;
    organisations: OrganisationsRepository;
    tasks: TasksRepository;
  };
}

/** The real service over the fake Gmail, in-memory repositories and a counting model. */
export function buildInboxHarness(options: InboxHarnessOptions = {}): InboxHarness {
  const gmail = options.gmail ?? FakeGmail.fromFixture();
  const model = new RecordingModel();
  const logs: string[] = [];
  const config = { ...TEST_INBOX_CONFIG, ...options.config };
  const repos = {
    inbound: new InMemoryInboundMessagesRepository(),
    admitted: new InMemoryAdmittedThreadsRepository(),
    excluded: new InMemoryExcludedThreadsRepository(),
    candidates: new InMemoryCandidateThreadsRepository(),
    contacts: new InMemoryContactsRepository(),
    cursor: new InMemoryInboxCursorRepository(),
    speakers: options.shared?.speakers ?? new InMemorySpeakersRepository(),
    events: options.shared?.events ?? new InMemoryEventsRepository(),
    organisations: options.shared?.organisations ?? new InMemoryOrganisationsRepository(),
    tasks: options.shared?.tasks ?? new InMemoryTasksRepository(),
  };
  const call: StructuredCall = (schema, prompt, opts) =>
    callStructured(schema, prompt, opts, {
      ladder: [{ provider: 'ollama', model: 'stub-triage' }],
      provider: () => model,
      maxAttempts: 2,
      timeoutMs: 1000,
      logger: { log: () => undefined, warn: () => undefined },
    });
  const deps: InboxDeps = {
    gmail: options.client ?? gmail,
    inbound: repos.inbound,
    admitted: repos.admitted,
    excluded: repos.excluded,
    candidates: repos.candidates,
    contacts: repos.contacts,
    cursor: repos.cursor,
    speakers: repos.speakers,
    events: repos.events,
    organisations: repos.organisations,
    tasks: repos.tasks,
    triager: new Triager({ call, maxChars: config.triageMaxChars, startAt: 0 }),
    config,
    log: (message, fields = {}) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  };
  return { gmail, model, repos, service: new InboxService(deps), logs, config };
}
