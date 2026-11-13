/**
 * The autonomy policy: one table, enforced in code at the service boundary. A graph node cannot
 * opt out of it and the model is never asked whether something needs approval.
 *
 *  - auto:    the system may just do it
 *  - approve: a human decision is required first (an ApprovalRequest + interrupt)
 *  - never:   not possible by any path; asking for it is a bug and throws
 */
export const AUTONOMY_ACTIONS = [
  'draft_internal_note',
  'create_task',
  'plan_review',
  'send_external_message',
  'delete_anything',
] as const;
export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number];

export type AutonomyLevel = 'auto' | 'approve' | 'never';

/**
 * `satisfies Record<AutonomyAction, AutonomyLevel>` makes this exhaustive at compile time: add an
 * action to AUTONOMY_ACTIONS without an entry here (or an entry that is not an action) and
 * `npm run typecheck` / the build fails. Frozen, so no code can change a level at runtime.
 */
export const AUTONOMY_POLICY: Readonly<Record<AutonomyAction, AutonomyLevel>> = Object.freeze({
  draft_internal_note: 'auto',
  create_task: 'auto',
  plan_review: 'approve',
  // Nothing sends yet: the entry exists so M4/M5 inherit the rule instead of inventing one.
  send_external_message: 'approve',
  delete_anything: 'never',
} satisfies Record<AutonomyAction, AutonomyLevel>);

export class AutonomyViolationError extends Error {
  constructor(public readonly action: AutonomyAction) {
    super(`Action "${action}" is never allowed by the autonomy policy`);
    this.name = 'AutonomyViolationError';
  }
}

/**
 * Call this at the service boundary before doing `action`. Returns 'auto' (proceed) or 'approve'
 * (create an ApprovalRequest and wait); throws AutonomyViolationError for 'never'.
 *
 * There is deliberately no second parameter, flag, environment variable or config value that
 * changes the answer: the table is the only input.
 */
export function requireAutonomy(action: AutonomyAction): 'auto' | 'approve' {
  const level = AUTONOMY_POLICY[action];
  switch (level) {
    case 'auto':
      return 'auto';
    case 'approve':
      return 'approve';
    case 'never':
      throw new AutonomyViolationError(action);
    default: {
      const unreachable: never = level;
      throw new AutonomyViolationError(unreachable);
    }
  }
}
