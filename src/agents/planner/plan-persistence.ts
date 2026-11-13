import { Injectable } from '@nestjs/common';
import type { Event } from '../../domain/event.schema.js';
import type { Task } from '../../domain/task.schema.js';
import type { Page } from '../../repositories/base.repository.js';
import type { EventsRepository } from '../../repositories/events.repository.js';
import type { TasksRepository } from '../../repositories/tasks.repository.js';
import type { ChecklistOutput } from './llm-schemas.js';
import {
  eventInputFromBrief,
  eventPatchFromBrief,
  mapChecklistToTasks,
  taskNaturalKey,
} from './mapping.js';
import type { EventBrief } from './planner.state.js';
import { type Milestone, utcDay } from './timeline.js';

export async function allPages<T>(fetchPage: (after?: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  do {
    const page = await fetchPage(after);
    items.push(...page.items);
    after = page.nextCursor;
  } while (after !== undefined);
  return items;
}

export class EventNotFoundError extends Error {
  constructor(public readonly eventId: string) {
    super(`No event with id ${eventId}`);
    this.name = 'EventNotFoundError';
  }
}

export interface InsertedTasks {
  created: Task[];
  /** Items that already existed (same event + milestone + normalised title). */
  skipped: number;
}

/**
 * Everything the planner writes to the domain collections. Every method is safe to run twice:
 * that is what lets a graph node be re-executed from its start after an interrupt or a failure.
 * Nothing here deletes or overwrites a task.
 */
@Injectable()
export class PlanPersistence {
  constructor(
    private readonly events: EventsRepository,
    private readonly tasks: TasksRepository,
  ) {}

  /** brief.eventId wins; otherwise match an event on the same UTC day with the same theme. */
  async findEvent(brief: EventBrief): Promise<Event | null> {
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

  /** Creates the event (phase planning) or updates the matched one via updateWithRetry. Idempotent. */
  async upsertEvent(brief: EventBrief): Promise<{ event: Event; created: boolean }> {
    const existing = await this.findEvent(brief);
    if (!existing) {
      return { event: await this.events.insert(eventInputFromBrief(brief)), created: true };
    }
    const updated = await this.events.updateWithRetry(existing._id, (doc) =>
      eventPatchFromBrief(brief, doc.phase),
    );
    return { event: updated ?? existing, created: false };
  }

  async eventTasks(eventId: string): Promise<Task[]> {
    return await allPages((after) =>
      this.tasks.findByEventId(eventId, { limit: 200, ...(after ? { after } : {}) }),
    );
  }

  async agentTaskCount(eventId: string): Promise<number> {
    return (await this.eventTasks(eventId)).filter((t) => t.source === 'agent').length;
  }

  /**
   * Inserts the checklist as tasks, skipping any whose natural key (eventId, milestoneKey,
   * normalised title) already exists, so running it twice adds nothing. Due dates come from the
   * code-computed milestones, never from the checklist.
   */
  async insertTasks(
    eventId: string,
    checklist: ChecklistOutput,
    milestones: readonly Milestone[],
  ): Promise<InsertedTasks> {
    const known = new Set(
      (await this.eventTasks(eventId)).map((t) => taskNaturalKey(eventId, t.milestoneKey, t.title)),
    );
    const created: Task[] = [];
    let skipped = 0;
    for (const input of mapChecklistToTasks(checklist, milestones, eventId)) {
      const key = taskNaturalKey(eventId, input.milestoneKey, input.title);
      if (known.has(key)) {
        skipped++;
        continue;
      }
      created.push(await this.tasks.insert(input));
      known.add(key);
    }
    return { created, skipped };
  }

  /**
   * Records a rejected plan on the event (phase stays `planning`): the reason is appended to the
   * event's notes once. The decision itself is persisted by the approvals service.
   */
  async recordRejection(eventId: string, reason: string): Promise<void> {
    const line = `Plan rejected: ${reason.trim()}`;
    await this.events.updateWithRetry(eventId, (doc) => {
      const notes = doc.notes ?? '';
      return {
        notes: notes.split('\n').includes(line) ? notes : [notes, line].filter(Boolean).join('\n'),
      };
    });
  }
}
