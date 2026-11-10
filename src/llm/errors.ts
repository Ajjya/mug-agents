import type { LlmCallRecord } from './model.types.js';

/** The model could not produce valid output within the ladder / attempt budget. */
export class StructuredOutputError extends Error {
  constructor(
    public readonly node: string,
    public readonly attempts: readonly LlmCallRecord[],
    /** The last validation issues. Never the raw model output. */
    public readonly issues: readonly string[],
    public readonly reason: 'ladder_exhausted' | 'max_attempts',
  ) {
    super(
      `Structured output failed in node "${node}" after ${String(attempts.length)} attempt(s) (${reason}): ${issues.slice(0, 3).join('; ') || 'no validation issues recorded'}`,
    );
    this.name = 'StructuredOutputError';
  }
}

/**
 * The provider itself failed (auth, 5xx, queue still full after backoff). Distinct from
 * StructuredOutputError so an outage is never reported as "the models cannot hold the schema".
 */
export class ProviderUnavailableError extends Error {
  constructor(
    public readonly node: string,
    public readonly attempts: readonly LlmCallRecord[],
    public readonly reason: string,
    public readonly status?: number,
  ) {
    super(`Provider unavailable in node "${node}": ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}
