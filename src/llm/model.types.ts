import type { ModelRef } from '../config/env.schema.js';

/** A JSON Schema document (what `z.toJSONSchema` produces). */
export type JsonSchema = Record<string, unknown>;

export interface ChatRequest {
  model: string;
  prompt: string;
  /** Always 0: every structured call is deterministic where the provider allows it. */
  temperature: 0;
  timeoutMs: number;
  /** Only set when the provider reports `constrainsOutput`; otherwise the schema is in the prompt. */
  jsonSchema?: JsonSchema;
}

export interface ChatResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** Time spent on the request itself (queueing for a concurrency slot is excluded). */
  latencyMs: number;
}

/**
 * The narrow interface the rest of the app depends on. Vendor details (model name suffixes, error
 * shapes, auth) stay behind it: failures are reported as ProviderError with a vendor-neutral kind.
 */
export interface LlmProvider {
  readonly name: string;
  /** True only when the provider provably enforces `jsonSchema` during decoding. */
  readonly constrainsOutput: boolean;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/**
 * - timeout / transport: the request did not complete; retried like a validation failure.
 * - queue_full: the provider's concurrency limit rejected us; retried on the same rung after a backoff.
 * - rejected: the provider refused this model/request (e.g. unknown model); try the next rung.
 * - unavailable: auth failure or provider 5xx; every rung would fail the same way.
 */
export type ProviderFailureKind =
  'timeout' | 'transport' | 'queue_full' | 'rejected' | 'unavailable';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderFailureKind,
    message: string,
    public readonly status?: number,
    public readonly latencyMs = 0,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type AttemptOutcome = 'valid' | 'invalid' | ProviderFailureKind;

/** One provider call. Never contains the prompt, the raw output or any credential. */
export interface LlmCallRecord {
  node: string;
  /** `provider:model`, e.g. `ollama:gpt-oss:20b`. */
  model: string;
  /** 1-based attempt number within the structured call. */
  attempt: number;
  /** 0-based index into the ladder. */
  rung: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  outcome: AttemptOutcome;
  /** Whether the provider enforced the schema during decoding (false = prompt-only). */
  constrained: boolean;
  /** Zod issues when outcome is 'invalid'. */
  issues?: string[];
}

export type RungChangeReason = 'validation' | 'timeout' | 'transport' | 'rejected';

export type { ModelRef };
