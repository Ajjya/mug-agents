const DAY_MS = 86_400_000;

/** Milestones in chronological order. Offsets are in days relative to the event day. */
export const MILESTONE_DEFS = [
  { key: 'T-8w', label: '8 weeks before', offsetDays: -56 },
  { key: 'T-6w', label: '6 weeks before', offsetDays: -42 },
  { key: 'T-4w', label: '4 weeks before', offsetDays: -28 },
  { key: 'T-3w', label: '3 weeks before', offsetDays: -21 },
  { key: 'T-2w', label: '2 weeks before', offsetDays: -14 },
  { key: 'T-1w', label: '1 week before', offsetDays: -7 },
  { key: 'T-2d', label: '2 days before', offsetDays: -2 },
  { key: 'day-of', label: 'Day of the event', offsetDays: 0 },
  { key: 'T+3d', label: '3 days after (follow-up)', offsetDays: 3 },
] as const;

export type MilestoneKey = (typeof MILESTONE_DEFS)[number]['key'];
export const MILESTONE_KEYS = MILESTONE_DEFS.map((m) => m.key) as [MilestoneKey, ...MilestoneKey[]];

export interface Milestone {
  key: MilestoneKey;
  label: string;
  /** UTC midnight of the milestone day, as an ISO-8601 instant. */
  dateIso: string;
  /** True when the real date was already in the past and was moved to today. */
  clamped: boolean;
}

export class PastEventDateError extends Error {
  constructor(
    public readonly eventDay: string,
    public readonly today: string,
  ) {
    super(`Event date ${eventDay} is in the past (today is ${today}); nothing to plan`);
    this.name = 'PastEventDateError';
  }
}

/** UTC midnight of the day containing `d`. */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Pure and deterministic: event date (+ "today") -> milestone dates. All arithmetic is on UTC
 * calendar days, so DST never shifts a milestone. Milestones that would fall before today are
 * clamped to today and flagged; an event day before today is rejected.
 */
export function computeMilestones(eventDateIso: string, now: Date): Milestone[] {
  const event = new Date(eventDateIso);
  if (Number.isNaN(event.getTime())) throw new RangeError(`Invalid event date: ${eventDateIso}`);
  const eventDay = utcDay(event);
  const today = utcDay(now);
  if (eventDay.getTime() < today.getTime()) {
    throw new PastEventDateError(
      eventDay.toISOString().slice(0, 10),
      today.toISOString().slice(0, 10),
    );
  }
  return MILESTONE_DEFS.map((def) => {
    const date = new Date(eventDay.getTime() + def.offsetDays * DAY_MS);
    const clamped = date.getTime() < today.getTime();
    return {
      key: def.key,
      label: def.label,
      dateIso: (clamped ? today : date).toISOString(),
      clamped,
    };
  });
}
