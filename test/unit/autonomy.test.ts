import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AUTONOMY_ACTIONS,
  AUTONOMY_POLICY,
  AutonomyViolationError,
  requireAutonomy,
  type AutonomyAction,
  type AutonomyLevel,
} from '../../src/approvals/autonomy.js';

describe('autonomy policy table', () => {
  it('maps each action to the level the spec requires', () => {
    expect(AUTONOMY_POLICY).toEqual({
      draft_internal_note: 'auto',
      create_task: 'auto',
      plan_review: 'approve',
      send_external_message: 'approve',
      delete_anything: 'never',
    });
  });

  it('has an entry for every action and no entry that is not an action (runtime)', () => {
    expect(Object.keys(AUTONOMY_POLICY).sort()).toEqual([...AUTONOMY_ACTIONS].sort());
    for (const action of AUTONOMY_ACTIONS) {
      expect(['auto', 'approve', 'never']).toContain(AUTONOMY_POLICY[action]);
    }
  });

  it('is exhaustive at compile time: the table keys are exactly the action union', () => {
    // These fail `npm run typecheck` if an action is added without a table entry, or the reverse.
    expectTypeOf<keyof typeof AUTONOMY_POLICY>().toEqualTypeOf<AutonomyAction>();
    expectTypeOf(AUTONOMY_POLICY).toExtend<Readonly<Record<AutonomyAction, AutonomyLevel>>>();
    // @ts-expect-error a table missing an action does not type-check
    const incomplete: Record<AutonomyAction, AutonomyLevel> = { create_task: 'auto' };
    expect(incomplete).toBeDefined();
  });

  it('is frozen: no code can change a level at runtime', () => {
    expect(Object.isFrozen(AUTONOMY_POLICY)).toBe(true);
    const table = AUTONOMY_POLICY as Record<string, string>;
    expect(() => {
      table['delete_anything'] = 'auto';
    }).toThrow(TypeError);
    expect(AUTONOMY_POLICY.delete_anything).toBe('never');
  });
});

describe('requireAutonomy', () => {
  it('returns auto or approve, per the table', () => {
    expect(requireAutonomy('draft_internal_note')).toBe('auto');
    expect(requireAutonomy('create_task')).toBe('auto');
    expect(requireAutonomy('plan_review')).toBe('approve');
    expect(requireAutonomy('send_external_message')).toBe('approve');
  });

  it('throws for never', () => {
    expect(() => requireAutonomy('delete_anything')).toThrow(AutonomyViolationError);
    expect(() => requireAutonomy('delete_anything')).toThrow(/never allowed/);
  });

  it('cannot be bypassed by an extra argument, a flag, or any environment/config value', () => {
    // @ts-expect-error there is no second parameter to pass
    expect(() => requireAutonomy('delete_anything', { force: true })).toThrow(
      AutonomyViolationError,
    );
    const saved = { ...process.env };
    try {
      for (const name of [
        'AUTONOMY_OVERRIDE',
        'FORCE',
        'ALLOW_DELETE',
        'AUTONOMY_DELETE_ANYTHING',
        'CI',
      ]) {
        process.env[name] = '1';
      }
      expect(() => requireAutonomy('delete_anything')).toThrow(AutonomyViolationError);
      expect(requireAutonomy('plan_review')).toBe('approve');
    } finally {
      process.env = saved;
    }
  });

  it('the function takes exactly one parameter', () => {
    expect(requireAutonomy.length).toBe(1);
  });
});
