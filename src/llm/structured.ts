import { z } from 'zod';
import { ATTEMPTS_PER_RUNG, type ModelRef, formatModelRef } from '../config/env.schema.js';
import { ProviderUnavailableError, StructuredOutputError } from './errors.js';
import {
  type AttemptOutcome,
  type LlmCallRecord,
  type LlmProvider,
  ProviderError,
  type RungChangeReason,
} from './model.types.js';

export interface LlmLogger {
  log(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
}

export interface StructuredDeps {
  ladder: readonly ModelRef[];
  provider: (name: ModelRef['provider']) => LlmProvider;
  /** Total provider calls (LLM_MAX_ATTEMPTS). */
  maxAttempts: number;
  timeoutMs: number;
  logger: LlmLogger;
  /** Backoff before retrying a queue_full rejection on the same rung. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  queueBackoffMs?: number;
  /** Consecutive queue_full rejections tolerated before the provider is declared unavailable. */
  queueRetries?: number;
}

export interface StructuredOptions {
  /** Graph node name, recorded on every call. */
  node: string;
  /** Ladder index to start at (default 0). */
  startAt?: number;
}

export interface StructuredResult<T> {
  value: T;
  calls: LlmCallRecord[];
  /** The rung that produced the value. */
  model: ModelRef;
}

/** The only thing nodes depend on: schema + prompt in, validated value (and call records) out. */
export type StructuredCall = <T>(
  schema: z.ZodType<T>,
  prompt: string,
  options: StructuredOptions,
) => Promise<StructuredResult<T>>;

const MAX_ISSUES = 10;

export function formatIssues(error: z.ZodError): string[] {
  return error.issues
    .slice(0, MAX_ISSUES)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
}

/** Strict parse: no fence stripping, no repair. Anything but a clean JSON document is a failure. */
function validate<T>(
  schema: z.ZodType<T>,
  content: string,
): { ok: true; value: T } | { ok: false; issues: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, issues: ['(root): the response was not a single valid JSON document'] };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: formatIssues(parsed.error) };
}

/**
 * Builds the request prompt. The strategy is an internal detail: a provider that enforces the
 * schema gets it as `jsonSchema`; otherwise the schema is spelled out in the prompt.
 */
function buildPrompt(
  base: string,
  schema: unknown,
  constrained: boolean,
  issues: readonly string[],
): string {
  const parts = [base];
  if (!constrained) {
    parts.push(
      'Respond with ONLY one JSON object that conforms to this JSON Schema. No prose, no markdown, no code fences, no extra keys.',
      JSON.stringify(schema),
    );
  }
  if (issues.length > 0) {
    parts.push(
      'Your previous answer was rejected by validation. Fix exactly these problems and answer again:',
      ...issues.map((i) => `- ${i}`),
    );
  }
  return parts.join('\n\n');
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Walks the model ladder. Policy (spec section 6):
 *  - temperature 0; a validation failure retries the same rung once (ATTEMPTS_PER_RUNG calls per rung in total)
 *    with the issues appended;
 *  - a second failure moves to the next rung (reason logged); never repairs output in code;
 *  - timeouts / transport errors count as attempts and are handled like validation failures;
 *  - queue_full retries the same rung after a backoff and never climbs;
 *  - auth failures and 5xx abort with ProviderUnavailableError (every rung is the same vendor);
 *  - the ladder or LLM_MAX_ATTEMPTS exhausted -> StructuredOutputError (issues only, no raw output).
 */
export async function callStructured<T>(
  schema: z.ZodType<T>,
  prompt: string,
  options: StructuredOptions,
  deps: StructuredDeps,
): Promise<StructuredResult<T>> {
  const { ladder, maxAttempts, timeoutMs, logger } = deps;
  const sleep = deps.sleep ?? realSleep;
  const queueBackoffMs = deps.queueBackoffMs ?? 1000;
  const queueRetries = deps.queueRetries ?? 2;
  const jsonSchema = z.toJSONSchema(schema);
  const calls: LlmCallRecord[] = [];

  let rung = options.startAt ?? 0;
  if (!Number.isInteger(rung) || rung < 0 || rung >= ladder.length) {
    throw new RangeError(
      `startAt ${String(rung)} is outside the ladder (size ${String(ladder.length)})`,
    );
  }
  let failuresOnRung = 0;
  let queueRejections = 0;
  let lastIssues: string[] = [];
  let lastKind: AttemptOutcome | undefined;

  const climb = (reason: RungChangeReason): boolean => {
    const next = rung + 1;
    if (next >= ladder.length) return false;
    const from = ladder[rung];
    const to = ladder[next];
    if (from && to) {
      logger.warn(
        'llm rung change',
        { node: options.node, from: formatModelRef(from), to: formatModelRef(to), reason },
        'Llm',
      );
    }
    rung = next;
    failuresOnRung = 0;
    // A model must not be asked to fix another model's answer: the new rung starts clean.
    lastIssues = [];
    return true;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ref = ladder[rung];
    if (!ref) throw new RangeError('rung out of range'); // unreachable: climb() guards the index
    const provider = deps.provider(ref.provider);
    const model = formatModelRef(ref);
    const record = (outcome: AttemptOutcome, extra: Partial<LlmCallRecord>): LlmCallRecord => {
      const r: LlmCallRecord = {
        node: options.node,
        model,
        attempt,
        rung,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        outcome,
        constrained: provider.constrainsOutput,
        ...extra,
      };
      calls.push(r);
      // Observability: metadata only, never the prompt or the raw output.
      logger.log('llm call', { ...r, issues: r.issues?.length }, 'Llm');
      return r;
    };

    try {
      const res = await provider.chat({
        model: ref.model,
        prompt: buildPrompt(prompt, jsonSchema, provider.constrainsOutput, lastIssues),
        temperature: 0,
        timeoutMs,
        ...(provider.constrainsOutput ? { jsonSchema } : {}),
      });
      const checked = validate(schema, res.content);
      const base = {
        tokensIn: res.promptTokens,
        tokensOut: res.completionTokens,
        latencyMs: res.latencyMs,
      };
      if (checked.ok) {
        record('valid', base);
        return { value: checked.value, calls, model: ref };
      }
      record('invalid', { ...base, issues: checked.issues });
      lastIssues = checked.issues;
      lastKind = 'invalid';
      queueRejections = 0;
      failuresOnRung++;
      if (failuresOnRung >= ATTEMPTS_PER_RUNG && !climb('validation')) {
        throw new StructuredOutputError(options.node, calls, lastIssues, 'ladder_exhausted');
      }
    } catch (err) {
      if (err instanceof StructuredOutputError) throw err;
      if (!(err instanceof ProviderError)) throw err;
      record(err.kind, { latencyMs: err.latencyMs });
      lastKind = err.kind;
      lastIssues = []; // a transport-level failure carries no validation feedback
      if (err.kind === 'unavailable') {
        throw new ProviderUnavailableError(options.node, calls, err.message, err.status);
      }
      if (err.kind === 'queue_full') {
        queueRejections++;
        if (queueRejections > queueRetries) {
          throw new ProviderUnavailableError(
            options.node,
            calls,
            `${err.message}; still full after ${String(queueRetries)} backoff retries`,
            err.status,
          );
        }
        await sleep(queueBackoffMs * 2 ** (queueRejections - 1));
        continue;
      }
      queueRejections = 0;
      if (err.kind === 'rejected') {
        if (!climb('rejected'))
          throw new StructuredOutputError(options.node, calls, [err.message], 'ladder_exhausted');
        continue;
      }
      failuresOnRung++;
      if (failuresOnRung >= ATTEMPTS_PER_RUNG && !climb(err.kind)) {
        throw new StructuredOutputError(options.node, calls, [err.message], 'ladder_exhausted');
      }
    }
  }

  // Out of attempts. A queue that never drained is a provider problem, not a model problem.
  if (lastKind === 'queue_full') {
    throw new ProviderUnavailableError(
      options.node,
      calls,
      'provider queue still full when attempts ran out',
    );
  }
  throw new StructuredOutputError(options.node, calls, lastIssues, 'max_attempts');
}
