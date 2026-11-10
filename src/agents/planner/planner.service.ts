import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Event } from '../../domain/event.schema.js';
import type { Task } from '../../domain/task.schema.js';
import type { LlmCallRecord } from '../../llm/model.types.js';
import { EVENTS_REPOSITORY, type EventsRepository } from '../../repositories/events.repository.js';
import { TASKS_REPOSITORY, type TasksRepository } from '../../repositories/tasks.repository.js';
import type { Page } from '../../repositories/base.repository.js';
import type { ChecklistOutput, TimelineOutput } from './llm-schemas.js';
import {
  eventInputFromBrief,
  eventPatchFromBrief,
  mapChecklistToTasks,
  taskNaturalKey,
} from './mapping.js';
import type { PlanDraft, PlanRunOptions, PlannerGraph } from './planner.graph.js';
import { EventBriefSchema, type EventBrief } from './planner.state.js';
import { type Milestone, computeMilestones, utcDay } from './timeline.js';

export const PLANNER_GRAPH = Symbol('PLANNER_GRAPH');

export class InvalidBriefError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid event brief:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'InvalidBriefError';
  }
}

export class EventNotFoundError extends Error {
  constructor(public readonly eventId: string) {
    super(`No event with id ${eventId}`);
    this.name = 'EventNotFoundError';
  }
}

export interface PlanResult {
  event: Event;
  /** True when the event was created by this run (false: an existing event was updated). */
  eventCreated: boolean;
  milestones: Milestone[];
  timeline: TimelineOutput;
  checklist: ChecklistOutput;
  /** Tasks inserted by this run. */
  created: Task[];
  /** Checklist items that already existed (same event + milestone + normalised title). */
  skipped: number;
  /** Every model call made, for evals and cost accounting. */
  calls: LlmCallRecord[];
}

async function allPages<T>(fetchPage: (after?: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  do {
    const page = await fetchPage(after);
    items.push(...page.items);
    after = page.nextCursor;
  } while (after !== undefined);
  return items;
}

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  constructor(
    @Inject(PLANNER_GRAPH) private readonly graph: PlannerGraph,
    @Inject(EVENTS_REPOSITORY) private readonly events: EventsRepository,
    @Inject(TASKS_REPOSITORY) private readonly tasks: TasksRepository,
  ) {}

  /** Validates the brief. Never touches a model or the database. */
  parseBrief(input: unknown): EventBrief {
    const parsed = EventBriefSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    throw new InvalidBriefError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  /**
   * Runs the graph, then persists. Order matters: the brief and its date are validated first (a
   * past date throws PastEventDateError here, before any model call), and nothing is written
   * until the model work has fully succeeded, so a failed run leaves no half-written plan.
   */
  async plan(input: unknown, options: PlanRunOptions = {}): Promise<PlanResult> {
    const brief = this.parseBrief(input);
    computeMilestones(brief.date, options.now ?? new Date()); // reject a past date up front
    const draft = await this.graph.run(brief, options);
    return await this.persist(draft);
  }

  /**
   * Creates or updates the Event and inserts the checklist as Tasks. Idempotent: a task is skipped
   * when its natural key (eventId, milestoneKey, normalised title) already exists. Nothing is ever
   * deleted or modified: re-planning only adds what is missing.
   *
   * Why a key check and not a unique index: the key includes a normalised title that is not a
   * stored field, and agents may legitimately create manual tasks with the same title. The check
   * is not atomic, so two planners racing on the same event could both insert; a run is a
   * deliberate CLI action, and a later run reports skipped rather than duplicating.
   */
  async persist(draft: PlanDraft): Promise<PlanResult> {
    const { event, created: eventCreated } = await this.upsertEvent(draft.brief);
    const existing = await allPages((after) =>
      this.tasks.findByEventId(event._id, { limit: 200, ...(after ? { after } : {}) }),
    );
    const known = new Set(existing.map((t) => taskNaturalKey(event._id, t.milestoneKey, t.title)));

    const created: Task[] = [];
    let skipped = 0;
    for (const input of mapChecklistToTasks(draft.checklist, draft.milestones, event._id)) {
      const key = taskNaturalKey(event._id, input.milestoneKey, input.title);
      if (known.has(key)) {
        skipped++;
        continue;
      }
      created.push(await this.tasks.insert(input));
      known.add(key);
    }
    this.logger.log(
      `planned event ${event._id}: ${String(created.length)} tasks created, ${String(skipped)} already existed`,
    );
    return {
      event,
      eventCreated,
      milestones: draft.milestones,
      timeline: draft.timeline,
      checklist: draft.checklist,
      created,
      skipped,
      calls: draft.calls,
    };
  }

  /** brief.eventId wins; otherwise match an event on the same day with the same theme; else create. */
  private async upsertEvent(brief: EventBrief): Promise<{ event: Event; created: boolean }> {
    const existing = await this.findEvent(brief);
    if (!existing) {
      return { event: await this.events.insert(eventInputFromBrief(brief)), created: true };
    }
    const updated = await this.events.updateWithRetry(existing._id, (doc) =>
      eventPatchFromBrief(brief, doc.phase),
    );
    return { event: updated ?? existing, created: false };
  }

  private async findEvent(brief: EventBrief): Promise<Event | null> {
    if (brief.eventId) {
      const found = await this.events.findById(brief.eventId);
      if (!found) throw new EventNotFoundError(brief.eventId);
      return found;
    }
    const day = utcDay(new Date(brief.date));
    const next = new Date(day.getTime() + 86_400_000);
    const sameDay = await allPages((after) =>
      this.events.findByDateRange(day.toISOString(), next.toISOString(), {
        limit: 200,
        ...(after ? { after } : {}),
      }),
    );
    const theme = brief.theme.trim().toLowerCase();
    return sameDay.find((e) => e.theme?.trim().toLowerCase() === theme) ?? null;
  }
}
