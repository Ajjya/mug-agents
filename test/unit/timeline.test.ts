import { describe, expect, it } from 'vitest';
import {
  MILESTONE_KEYS,
  PastEventDateError,
  computeMilestones,
} from '../../src/agents/planner/timeline.js';

const NOW = new Date('2026-11-10T10:00:00.000Z');

describe('computeMilestones', () => {
  it('returns the nine milestones in order, dated from the event day', () => {
    const m = computeMilestones('2027-03-10T18:30:00.000Z', NOW);
    expect(m.map((x) => x.key)).toEqual([
      'T-8w',
      'T-6w',
      'T-4w',
      'T-3w',
      'T-2w',
      'T-1w',
      'T-2d',
      'day-of',
      'T+3d',
    ]);
    expect(m.map((x) => x.key)).toEqual([...MILESTONE_KEYS]);
    expect(m.map((x) => x.dateIso.slice(0, 10))).toEqual([
      '2027-01-13',
      '2027-01-27',
      '2027-02-10',
      '2027-02-17',
      '2027-02-24',
      '2027-03-03',
      '2027-03-08',
      '2027-03-10',
      '2027-03-13',
    ]);
    expect(m.every((x) => !x.clamped)).toBe(true);
    expect(m.every((x) => x.dateIso.endsWith('T00:00:00.000Z'))).toBe(true);
  });

  it('is chronological', () => {
    const m = computeMilestones('2027-03-10T18:30:00.000Z', NOW);
    const t = m.map((x) => new Date(x.dateIso).getTime());
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });

  it('clamps milestones already in the past to today and flags them (< 8 weeks away)', () => {
    const m = computeMilestones('2026-12-01T00:00:00.000Z', NOW); // 21 days away
    const byKey = Object.fromEntries(m.map((x) => [x.key, x]));
    expect(byKey['T-8w']).toMatchObject({ dateIso: '2026-11-10T00:00:00.000Z', clamped: true });
    expect(byKey['T-6w']).toMatchObject({ dateIso: '2026-11-10T00:00:00.000Z', clamped: true });
    expect(byKey['T-4w']).toMatchObject({ dateIso: '2026-11-10T00:00:00.000Z', clamped: true });
    expect(byKey['T-3w']).toMatchObject({ dateIso: '2026-11-10T00:00:00.000Z', clamped: false }); // exactly today
    expect(byKey['T-2w']).toMatchObject({ dateIso: '2026-11-17T00:00:00.000Z', clamped: false });
    // still non-decreasing after clamping
    const t = m.map((x) => new Date(x.dateIso).getTime());
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });

  it('an event today is valid: everything before day-of is clamped', () => {
    const m = computeMilestones('2026-11-10T20:00:00.000Z', NOW);
    expect(m.filter((x) => x.clamped).map((x) => x.key)).toEqual([
      'T-8w',
      'T-6w',
      'T-4w',
      'T-3w',
      'T-2w',
      'T-1w',
      'T-2d',
    ]);
    expect(m.find((x) => x.key === 'day-of')?.dateIso).toBe('2026-11-10T00:00:00.000Z');
    expect(m.find((x) => x.key === 'T+3d')?.dateIso).toBe('2026-11-13T00:00:00.000Z');
  });

  it('rejects an event date in the past', () => {
    expect(() => computeMilestones('2026-11-09T23:59:00.000Z', NOW)).toThrow(PastEventDateError);
    expect(() => computeMilestones('2026-11-09T23:59:00.000Z', NOW)).toThrow(/in the past/);
  });

  it('uses UTC days, so a DST change does not shift a milestone', () => {
    // Europe/Lisbon moves clocks on 2027-03-28; 8 weeks before 2027-04-04 crosses it.
    const m = computeMilestones('2027-04-04T00:00:00.000Z', NOW);
    expect(m[0]?.dateIso).toBe('2027-02-07T00:00:00.000Z');
  });

  it('rejects an unparseable date', () => {
    expect(() => computeMilestones('nope', NOW)).toThrow(RangeError);
  });
});
