import type { Price } from '../config/env.schema.js';
import type { LlmCallRecord } from './model.types.js';

/** Cost of one call from the configured price map, or undefined when the model has no price. */
export function callCost(
  record: LlmCallRecord,
  prices: Readonly<Record<string, Price>>,
): number | undefined {
  const price = prices[record.model];
  if (!price) return undefined;
  return (
    (record.tokensIn * price.inputPerMTok + record.tokensOut * price.outputPerMTok) / 1_000_000
  );
}

export interface UsageSummary {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** Undefined when any call used a model without a configured price (so it is never understated). */
  cost: number | undefined;
}

export function summariseCalls(
  records: readonly LlmCallRecord[],
  prices: Readonly<Record<string, Price>>,
): UsageSummary {
  let cost: number | undefined = 0;
  for (const r of records) {
    const c = callCost(r, prices);
    cost = c === undefined || cost === undefined ? undefined : cost + c;
  }
  return {
    calls: records.length,
    tokensIn: records.reduce((n, r) => n + r.tokensIn, 0),
    tokensOut: records.reduce((n, r) => n + r.tokensOut, 0),
    latencyMs: records.reduce((n, r) => n + r.latencyMs, 0),
    cost,
  };
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}
