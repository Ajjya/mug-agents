import type { EntityId } from '../../domain/common.js';
import type { EventInput, EventPatch, EventPhase } from '../../domain/event.schema.js';
import type { TaskInput } from '../../domain/task.schema.js';
import { type ChecklistOutput, normaliseTitle } from './llm-schemas.js';
import type { EventBrief } from './planner.state.js';
import type { Milestone } from './timeline.js';

/** Brief notes plus the co-host name (the brief has a name, not an organisation id). */
function notesFrom(brief: EventBrief): string | undefined {
  const parts = [brief.notes?.trim(), brief.coHost ? `Co-host: ${brief.coHost}` : undefined].filter(
    (p): p is string => p !== undefined && p !== '',
  );
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Brief -> a new Event in phase `planning`. */
export function eventInputFromBrief(brief: EventBrief): EventInput {
  const notes = notesFrom(brief);
  return {
    title: brief.theme,
    theme: brief.theme,
    phase: 'planning',
    date: brief.date,
    capacity: brief.capacity,
    coHostOrganisationIds: [],
    agenda: [],
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * Brief -> patch for an existing Event. The phase only moves idea -> planning: planning must never
 * drag an event that is already confirmed/published back to an earlier phase.
 */
export function eventPatchFromBrief(brief: EventBrief, currentPhase: EventPhase): EventPatch {
  const notes = notesFrom(brief);
  return {
    theme: brief.theme,
    date: brief.date,
    capacity: brief.capacity,
    ...(notes === undefined ? {} : { notes }),
    ...(currentPhase === 'idea' ? { phase: 'planning' as const } : {}),
  };
}

/**
 * The one place LLM output becomes domain data. The due date is the milestone date (computed in
 * code); the id, status, source and link are set here, never by the model.
 */
export function mapChecklistToTasks(
  checklist: ChecklistOutput,
  milestones: readonly Milestone[],
  eventId: EntityId,
): TaskInput[] {
  const byKey = new Map(milestones.map((m) => [m.key, m]));
  return checklist.tasks.map((item) => {
    const milestone = byKey.get(item.milestone);
    if (!milestone) throw new RangeError(`Unknown milestone "${item.milestone}"`); // schema-guarded
    return {
      title: item.title,
      owner: item.owner,
      dueAt: milestone.dateIso,
      status: 'open',
      source: 'agent',
      relatedEventId: eventId,
      milestoneKey: milestone.key,
    };
  });
}

/**
 * Idempotency key: (event, milestone, normalised title). Normalising (case, whitespace) means
 * "Book venue" and "  book   VENUE " are the same task.
 */
export function taskNaturalKey(
  eventId: string,
  milestoneKey: string | undefined,
  title: string,
): string {
  return `${eventId.toLowerCase()}|${milestoneKey ?? ''}|${normaliseTitle(title)}`;
}
