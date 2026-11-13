import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import { ApprovalRequestGate } from '../../src/approvals/approval-gate.js';
import type {
  ApprovalDecisionsRepository,
  ApprovalRequestsRepository,
} from '../../src/approvals/approvals.repository.js';
import { ApprovalsService } from '../../src/approvals/approvals.service.js';
import { PlanPersistence } from '../../src/agents/planner/plan-persistence.js';
import {
  type ApprovalGate,
  buildApprovalGraph,
  type EnsureRequestInput,
} from '../../src/agents/planner/planner.graph.js';
import { PlannerRuntime, type RetentionPort } from '../../src/agents/planner/planner.runtime.js';
import { PlannerService } from '../../src/agents/planner/planner.service.js';
import { InMemoryThreadLock, type ThreadLock } from '../../src/graph/thread-lock.js';
import { ProviderUnavailableError } from '../../src/llm/errors.js';
import type { LlmCallRecord } from '../../src/llm/model.types.js';
import type { StructuredCall } from '../../src/llm/structured.js';
import type { EventsRepository } from '../../src/repositories/events.repository.js';
import type { TasksRepository } from '../../src/repositories/tasks.repository.js';
import { checklistOutput, timelineOutput } from './planner-fixtures.js';

export interface Repos {
  events: EventsRepository;
  tasks: TasksRepository;
  requests: ApprovalRequestsRepository;
  decisions: ApprovalDecisionsRepository;
}

/** A retention port that only records what it was asked to do. */
export class RecordingRetention implements RetentionPort {
  stamped: string[] = [];
  cancelled: string[] = [];
  constructor(private readonly saver: MemorySaver) {}
  scheduleExpiry(threadId: string): Promise<void> {
    this.stamped.push(threadId);
    return Promise.resolve();
  }
  cancelExpiry(threadId: string): Promise<void> {
    this.stamped = this.stamped.filter((t) => t !== threadId);
    this.cancelled.push(threadId);
    return Promise.resolve();
  }
  /** Threads the in-memory saver knows that have not been stamped as completed. */
  inFlightThreadIds(): Promise<string[]> {
    return Promise.resolve(
      Object.keys(this.saver.storage)
        .filter((t) => !this.stamped.includes(t))
        .sort(),
    );
  }
}

export interface Behaviour {
  /** Make this node's model call fail with a provider outage (503). */
  failNode: string | undefined;
  /** Throw (simulating a process crash) right after the approval request is written. */
  crashAfterRequest: boolean;
  /** Override the checklist the stub model proposes. */
  checklist: ReturnType<typeof checklistOutput> | undefined;
}

export class SimulatedCrash extends Error {
  constructor() {
    super('simulated process crash');
    this.name = 'SimulatedCrash';
  }
}

export interface Harness {
  repos: Repos;
  planner: PlannerService;
  approvals: ApprovalsService;
  runtime: PlannerRuntime;
  persistence: PlanPersistence;
  retention: RetentionPort;
  behaviour: Behaviour;
  /** Every node the stub model was asked to run, in order. */
  modelCalls: string[];
  /** The ladder start each model call was given (undefined = first rung). */
  modelStartAts: (number | undefined)[];
}

export interface HarnessOptions {
  saver?: BaseCheckpointSaver;
  retention?: RetentionPort;
  lock?: ThreadLock;
}

/**
 * The real graph, runtime and services wired to a deterministic stub model. Repositories and the
 * checkpointer are injected, so the same scenarios run against fakes + MemorySaver (unit) and
 * MongoDB + the Mongo checkpointer (integration).
 */
export function buildHarness(repos: Repos, options: HarnessOptions = {}): Harness {
  const behaviour: Behaviour = {
    failNode: undefined,
    crashAfterRequest: false,
    checklist: undefined,
  };
  const modelCalls: string[] = [];
  const modelStartAts: (number | undefined)[] = [];
  const record = (node: string): LlmCallRecord => ({
    node,
    model: 'ollama:stub',
    attempt: 1,
    rung: 0,
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
    outcome: 'valid',
    constrained: false,
  });
  const call: StructuredCall = (_schema, _prompt, opts) => {
    modelCalls.push(opts.node);
    modelStartAts.push(opts.startAt);
    if (behaviour.failNode === opts.node) {
      return Promise.reject(
        new ProviderUnavailableError(
          opts.node,
          [record(opts.node)],
          'provider error (HTTP 503)',
          503,
        ),
      );
    }
    const value =
      opts.node === 'generateTimeline'
        ? timelineOutput()
        : (behaviour.checklist ?? checklistOutput());
    return Promise.resolve({
      value: value as never,
      calls: [record(opts.node)],
      model: { provider: 'ollama', model: 'stub' },
    });
  };

  const realGate = new ApprovalRequestGate(repos.requests);
  const gate: ApprovalGate = {
    async ensureRequest(input: EnsureRequestInput) {
      const r = await realGate.ensureRequest(input);
      if (behaviour.crashAfterRequest) throw new SimulatedCrash();
      return r;
    },
  };
  const persistence = new PlanPersistence(repos.events, repos.tasks);
  const saver = options.saver ?? new MemorySaver();
  const retention =
    options.retention ??
    new RecordingRetention(saver instanceof MemorySaver ? saver : new MemorySaver());
  const runtime = new PlannerRuntime(
    buildApprovalGraph({ call, gate, persistence }, saver),
    retention,
    options.lock ?? new InMemoryThreadLock(),
  );
  return {
    repos,
    planner: new PlannerService(persistence, runtime, repos.requests),
    approvals: new ApprovalsService(repos.requests, repos.decisions, runtime),
    runtime,
    persistence,
    retention,
    behaviour,
    modelCalls,
    modelStartAts,
  };
}
