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

/** Embedding providers the registry can build. Local only, by decision (see docs/data-handling.md). */
export const EMBEDDING_PROVIDERS = ['ollama-local'] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];

export interface EmbedderRef {
  provider: EmbeddingProviderName;
  model: string;
}

export const formatEmbedderRef = (ref: EmbedderRef): string => `${ref.provider}:${ref.model}`;

/** `ollama-local:nomic-embed-text,ollama-local:other` -> refs. Unknown provider or duplicates rejected. */
export const embedderListSchema = z.string().transform((value, ctx) => {
  const refs: EmbedderRef[] = [];
  for (const part of value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const idx = part.indexOf(':');
    const provider = idx === -1 ? part : part.slice(0, idx);
    const model = idx === -1 ? '' : part.slice(idx + 1);
    if (!(EMBEDDING_PROVIDERS as readonly string[]).includes(provider) || model === '') {
      ctx.addIssue({
        code: 'custom',
        message: `"${part}" is not <${EMBEDDING_PROVIDERS.join('|')}>:<model>`,
      });
      return z.NEVER;
    }
    refs.push({ provider: provider as EmbeddingProviderName, model });
  }
  const names = refs.map(formatEmbedderRef);
  if (refs.length === 0 || new Set(names).size !== names.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'must list at least one embedder, without duplicates',
    });
    return z.NEVER;
  }
  return refs;
});

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
  /** Local Ollama, used for EMBEDDINGS ONLY (generation stays on Ollama Cloud). */
  OLLAMA_LOCAL_BASE_URL: z.url().default('http://127.0.0.1:11434'),
  /** The embedding model the service uses. Every chunk records it; a different model is refused at query time. */
  EMBEDDING_MODEL: z.string().trim().min(1).default('nomic-embed-text'),
  /** Embedders the retrieval eval compares (a matrix dimension, like the model ladder). Default: EMBEDDING_MODEL. */
  EVAL_EMBEDDERS: embedderListSchema.optional(),
  /** Which store the service searches: brute-force cosine in Node, or a $vectorSearch index. */
  RETRIEVAL_STORE: z.enum(['bruteforce', 'atlas']).default('bruteforce'),
  /** A MongoDB with Search (mongodb-atlas-local) for the Atlas arm of the eval and its opt-in tests. */
  ATLAS_LOCAL_URI: z.string().min(1).optional(),
  /**
   * Cosine below this is "not relevant": returned as nothing, never as the least-bad hit. 0.575 is
   * calibrated for nomic-embed-text on the 12-document sample (unrelated queries top out at 0.569, the
   * weakest answerable case at 0.582, direct matches 0.70+). The margin is under 0.01 either side and
   * it moved when the corpus grew (0.56 was enough at 10 documents). Re-measure on the real corpus.
   */
  VECTOR_MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.575),
  /**
   * Scale-free vector gate, alongside VECTOR_MIN_SCORE (both must pass): the top cosine minus the
   * median cosine of the retrieved set. Not tied to a model's score band. On the sample it does NOT
   * separate no-answer from answerable queries (no-answer gaps about 0.10; answerable 0.055 to 0.27),
   * so 0.05 sits below every answerable case and rejects nothing there: it guards against a flat
   * score distribution, it is not what makes no-answer work today. See the eval report.
   */
  VECTOR_MIN_GAP: z.coerce.number().min(0).max(2).default(0.05),
  /**
   * The keyword arm's own no-answer gate: the share of the query's distinct terms (stopwords removed)
   * a chunk must contain. Without it any single shared word made a chunk a keyword hit. BM25 scores
   * are not comparable across queries, so the gate is on coverage, not on the score.
   */
  KEYWORD_MIN_COVERAGE: z.coerce.number().min(0).max(1).default(0.5),
  /** Sent chases of one kind per speaker per event before the Speakers agent stops and creates a task. */
  CHASE_MAX_ROUNDS: z.coerce.number().int().min(1).max(10).default(2),
  /** Days since the last SENT message of a thread before the next chase is due. */
  CHASE_MIN_INTERVAL_DAYS: z.coerce.number().int().min(1).max(60).default(7),
  /** Drafts one Speakers run may produce, so a wrong clock or a stale event cannot make a pile. */
  MAX_DRAFTS_PER_RUN: z.coerce.number().int().min(0).max(100).default(10),
  /** Time zone event times are written in, in drafts (IANA name). */
  EVENT_TIME_ZONE: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'must be an IANA time zone, e.g. Europe/Lisbon')
    .default('Europe/Lisbon'),
  // ---- Inbox (M4a). The labels are the access-control model: see src/inbox/inbox.config.ts. ----
  /** Full-trust label: bodies are fetched, triaged and linked. Required to start the inbox; no default. */
  GMAIL_LABEL: z.string().trim().min(1).optional(),
  /** Metadata-only label: nothing but headers is ever fetched. Required, distinct, no default. */
  GMAIL_CANDIDATE_LABEL: z.string().trim().min(1).optional(),
  /** Gmail over IMAP with an app password. The password is a secret: never logged, never in an error. */
  IMAP_HOST: z.string().trim().min(1).default('imap.gmail.com'),
  IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(993),
  IMAP_USER: z.string().trim().min(1).optional(),
  IMAP_APP_PASSWORD: z.string().min(1).optional(),
  /** The ladder rung triage starts on (a `provider:model` that must be in LLM_MODEL_LADDER). */
  TRIAGE_START_MODEL: z.string().trim().min(1).default('ollama:gpt-oss:20b'),
  /** Bound on the redacted text a triage prompt may carry (truncated from the end, with a marker). */
  /**
   * The most one message's triage may take across the whole model ladder. Without it a message that keeps
   * failing validation can hold the run for attempts x LLM_TIMEOUT_MS. When it passes, the ladder stops, the
   * message is marked failed with the reason, and the batch moves on.
   */
  TRIAGE_MESSAGE_DEADLINE_MS: z.coerce.number().int().min(1).default(120_000),
  TRIAGE_MAX_CHARS: z.coerce.number().int().min(500).max(50_000).default(6000),
  /**
   * Senders whose mail is `document_share`, decided in code with no model call: exact addresses, or
   * `@domain` for a whole domain, comma-separated. These are Google's own notification senders.
   */
  INBOX_DOCUMENT_SHARE_SENDERS: z
    .string()
    .default(
      'drive-shares-dm-noreply@google.com,drive-shares-noreply@google.com,comments-noreply@docs.google.com',
    ),
  /** Pages of UIDs one folder sweep may read per poll: bounds a first backfill and a UIDVALIDITY re-sweep. */
  GMAIL_SWEEP_MAX_PAGES: z.coerce.number().int().min(1).max(100).default(20),
  GMAIL_SWEEP_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(200),
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
