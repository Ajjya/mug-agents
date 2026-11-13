import { z } from 'zod';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Providers the registry knows how to build. Adding a vendor = add it here + implement it. */
export const LLM_PROVIDERS = ['ollama'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export interface ModelRef {
  provider: LlmProviderName;
  model: string;
}

/** `ollama:gpt-oss:20b` -> { provider: 'ollama', model: 'gpt-oss:20b' } (split on the FIRST colon). */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

export function parseModelRef(raw: string): ModelRef | string {
  const idx = raw.indexOf(':');
  const provider = idx === -1 ? raw : raw.slice(0, idx);
  const model = idx === -1 ? '' : raw.slice(idx + 1);
  if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    return `unknown provider "${provider}" in "${raw}" (known: ${LLM_PROVIDERS.join(', ')})`;
  }
  if (model.trim() === '') return `missing model name in "${raw}"`;
  return { provider: provider as LlmProviderName, model };
}

export const DEFAULT_MODEL_LADDER = 'ollama:gemma4:31b,ollama:gpt-oss:20b,ollama:mistral-large-4';

/** Ordered, comma-separated model refs. Rungs must differ; one rung means "no escalation". */
export const modelLadderSchema = z
  .string()
  .default(DEFAULT_MODEL_LADDER)
  .transform((value, ctx) => {
    const refs: ModelRef[] = [];
    for (const part of value.split(',').map((p) => p.trim())) {
      if (part === '') continue;
      const parsed = parseModelRef(part);
      if (typeof parsed === 'string') {
        ctx.addIssue({ code: 'custom', message: parsed });
        return z.NEVER;
      }
      refs.push(parsed);
    }
    if (refs.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'must contain at least one model ref' });
      return z.NEVER;
    }
    const names = refs.map(formatModelRef);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup !== undefined) {
      ctx.addIssue({ code: 'custom', message: `duplicate rung "${dup}": rungs must differ` });
      return z.NEVER;
    }
    return refs;
  });

export const PriceSchema = z
  .object({ inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative() })
  .strict();
export type Price = z.infer<typeof PriceSchema>;

/** JSON map of model ref -> price per 1M tokens. Never hard-coded: prices change. */
export const pricesSchema = z
  .string()
  .default('{}')
  .transform((value, ctx) => {
    let json: unknown;
    try {
      json = JSON.parse(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
      return z.NEVER;
    }
    const parsed = z.record(z.string(), PriceSchema).safeParse(json);
    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        message: `must map model ref to { inputPerMTok, outputPerMTok }: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      });
      return z.NEVER;
    }
    return parsed.data;
  });

/**
 * Provider calls one ladder rung gets before the ladder climbs: the first try plus one correction
 * retry. The single source for both the config check below and callStructured's climbing rule.
 */
export const ATTEMPTS_PER_RUNG = 2;

/** Attempts needed for the last rung to be reachable: every earlier rung is fully used first. */
export const minAttemptsToReachAllRungs = (rungs: number): number =>
  ATTEMPTS_PER_RUNG * (rungs - 1) + 1;

/** Default budget: every rung gets its full share. */
export const defaultMaxAttempts = (rungs: number): number => ATTEMPTS_PER_RUNG * rungs;

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'), {
      message: 'must start with mongodb:// or mongodb+srv://',
    }),
  MONGODB_DB: z.string().min(1),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  OLLAMA_BASE_URL: z.url().default('https://ollama.com/v1'),
  /** Secret. Optional at boot (tests run without it); checked when a model call is attempted. */
  OLLAMA_API_KEY: z.string().min(1).optional(),
  /** A provider limit, not a tuning knob. */
  OLLAMA_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  LLM_MODEL_LADDER: modelLadderSchema,
  LLM_PRICES: pricesSchema,
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1).default(60_000),
  /** Days a *completed* thread's checkpoints are kept. Paused or failed threads never expire. */
  CHECKPOINT_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  /** Who approvals are recorded as when the CLI is not given --by. No auth yet: recorded as-is. */
  APPROVER_NAME: z.string().trim().min(1).optional(),
  /**
   * Total provider calls per structured call. Default: ATTEMPTS_PER_RUNG x ladder length. Must be
   * large enough that every rung is reachable (checked below).
   */
  LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).optional(),
});

export const envSchema = baseEnvSchema.transform((env, ctx) => {
  const ladder = env.LLM_MODEL_LADDER;
  const maxAttempts = env.LLM_MAX_ATTEMPTS ?? defaultMaxAttempts(ladder.length);
  // Rung i (0-based) is first used on attempt ATTEMPTS_PER_RUNG * i + 1.
  const unreachable = ladder
    .map((ref, i) => ({ ref, rung: i + 1, firstAttempt: ATTEMPTS_PER_RUNG * i + 1 }))
    .filter((r) => r.firstAttempt > maxAttempts);
  if (unreachable.length > 0) {
    const names = unreachable
      .map((r) => `rung ${String(r.rung)} (${formatModelRef(r.ref)})`)
      .join(', ');
    ctx.addIssue({
      code: 'custom',
      path: ['LLM_MAX_ATTEMPTS'],
      message:
        `${String(maxAttempts)} attempts can never reach ${names}: each rung gets ${String(ATTEMPTS_PER_RUNG)} attempts, ` +
        `so ${String(ladder.length)} rungs need at least ${String(minAttemptsToReachAllRungs(ladder.length))}. ` +
        `Raise LLM_MAX_ATTEMPTS (default ${String(defaultMaxAttempts(ladder.length))}) or shorten LLM_MODEL_LADDER`,
    });
    return z.NEVER;
  }
  return { ...env, LLM_MAX_ATTEMPTS: maxAttempts };
});

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Pure: validates an env-like record. Throws ConfigError listing every problem. */
export function parseEnv(env: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(env);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  );
}
