import type { Price } from '../src/config/env.schema.js';
import type { LlmCallRecord } from '../src/llm/model.types.js';
import { percentile, summariseCalls } from '../src/llm/usage.js';

export type CaseStatus = 'pass' | 'fail' | 'provider_failure';

export interface CaseOutcome {
  caseId: string;
  /** `provider:model`. */
  model: string;
  status: CaseStatus;
  /** The first failing assertion (or the failure reason). */
  failure?: string;
  calls: LlmCallRecord[];
}

export interface ModelInfo {
  model: string;
  /** Whether the provider enforces the schema during decoding (spec 3a). */
  constrained: boolean;
}

const esc = (s: string): string => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export interface ModelSummary {
  model: string;
  pass: number;
  fail: number;
  providerFailures: number;
  /** pass / (pass + fail): provider failures are excluded, they say nothing about the model. */
  passRate: number | undefined;
  /** Passed cases whose every model call was valid on the first attempt of its node. */
  firstTryPasses: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  tokensIn: number;
  tokensOut: number;
  cost: number | undefined;
}

export function summariseModel(
  model: string,
  outcomes: readonly CaseOutcome[],
  prices: Readonly<Record<string, Price>>,
): ModelSummary {
  const mine = outcomes.filter((o) => o.model === model);
  const pass = mine.filter((o) => o.status === 'pass').length;
  const fail = mine.filter((o) => o.status === 'fail').length;
  const calls = mine.flatMap((o) => o.calls);
  const latencies = calls.map((c) => c.latencyMs).filter((l) => l > 0);
  const usage = summariseCalls(calls, prices);
  return {
    model,
    pass,
    fail,
    providerFailures: mine.filter((o) => o.status === 'provider_failure').length,
    passRate: pass + fail === 0 ? undefined : pass / (pass + fail),
    firstTryPasses: mine.filter(
      (o) => o.status === 'pass' && o.calls.every((c) => c.attempt === 1 && c.outcome === 'valid'),
    ).length,
    medianLatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    cost: usage.cost,
  };
}

export function renderReport(input: {
  date: string;
  caseIds: readonly string[];
  models: readonly ModelInfo[];
  outcomes: readonly CaseOutcome[];
  prices: Readonly<Record<string, Price>>;
  maxConcurrency: number;
}): string {
  const { date, caseIds, models, outcomes, prices } = input;
  const summaries = models.map((m) => summariseModel(m.model, outcomes, prices));
  const lines: string[] = [];
  lines.push(`# Planner eval report (${date})`, '');
  lines.push(
    `${String(caseIds.length)} cases x ${String(models.length)} model(s). Each model is evaluated on its own pinned rung: escalation is disabled, so a validation failure after the one same-rung correction retry is a failed case. Provider concurrency capped at ${String(input.maxConcurrency)}.`,
    '',
  );
  lines.push('## Decoding mode', '');
  lines.push(
    ...models.map(
      (m) =>
        `- \`${m.model}\`: ${m.constrained ? 'schema-constrained decoding' : '**prompt-only** (schema in the prompt; the provider does not enforce it, so validation + retry carry the load)'}`,
    ),
    '',
  );
  lines.push('## Summary', '');
  lines.push(
    '| Model | Pass | Fail | Provider failures | Pass rate | First-try passes | Median call latency | p95 call latency | Tokens in | Tokens out | Est. cost |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const s of summaries) {
    lines.push(
      `| \`${s.model}\` | ${String(s.pass)} | ${String(s.fail)} | ${String(s.providerFailures)} | ${s.passRate === undefined ? 'n/a' : `${(s.passRate * 100).toFixed(0)}%`} | ${String(s.firstTryPasses)} | ${seconds(s.medianLatencyMs)} | ${seconds(s.p95LatencyMs)} | ${String(s.tokensIn)} | ${String(s.tokensOut)} | ${s.cost === undefined ? 'n/a (no price in LLM_PRICES)' : `$${s.cost.toFixed(4)}`} |`,
    );
  }
  lines.push(
    '',
    'Pass rate excludes provider failures (outages, auth, a queue that stayed full): they say nothing about the model. Cost is credits consumed at the prices in `LLM_PRICES`.',
    '',
  );
  lines.push(
    '## Results',
    '',
    '| Case | Model | Result | First failing assertion | Calls | Model time |',
    '|---|---|---|---|---|---|',
  );
  for (const id of caseIds) {
    for (const m of models) {
      const o = outcomes.find((x) => x.caseId === id && x.model === m.model);
      if (!o) continue;
      const label =
        o.status === 'pass' ? 'PASS' : o.status === 'fail' ? 'FAIL' : 'PROVIDER FAILURE';
      const time = o.calls.reduce((n, c) => n + c.latencyMs, 0);
      lines.push(
        `| ${id} | \`${m.model}\` | ${label} | ${o.failure ? esc(o.failure) : ''} | ${String(o.calls.length)} | ${seconds(time)} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
