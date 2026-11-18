import { percentile } from '../llm/usage.js';
import type { GoldenFile } from './golden.js';
import type { TriageOutput } from './triage.schema.js';

/** What one model did on one golden message. A case with no valid output is a miss, never skipped. */
export interface CaseResult {
  id: string;
  expected: Pick<
    GoldenFile['expected'],
    'intent' | 'sentiment_decision' | 'materials' | 'needs_human'
  >;
  /** The schema-valid summary, or undefined when the model never produced one. */
  output?: TriageOutput | undefined;
  /** Spans in `mentions` that are not in the text the model was given. */
  fabricatedSpans: number;
  mentionSpans: number;
  attempts: number;
  invalidAttempts: number;
  latenciesMs: number[];
  constrained: boolean;
}

export interface ModelScore {
  messages: number;
  answered: number;
  intent: number;
  sentiment_decision: number;
  /** Exact match of all four flags. */
  materials: number;
  needsHuman: {
    precision: number | null;
    recall: number | null;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
  };
  /** Spans that are not verbatim in the text, over all spans reported. */
  fabricationRate: number | null;
  casesWithFabrication: number;
  /** Failed validations over all attempts (retries included). */
  validationFailureRate: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  constrainedDecoding: boolean;
}

const sameMaterials = (a: TriageOutput['materials'], b: TriageOutput['materials']): boolean =>
  a.abstract === b.abstract && a.bio === b.bio && a.photo === b.photo && a.slides === b.slides;

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

export function scoreModel(cases: readonly CaseResult[]): ModelScore {
  const n = cases.length;
  const answered = cases.filter((c) => c.output !== undefined);
  const hits = (f: (c: CaseResult) => boolean): number => cases.filter(f).length / Math.max(n, 1);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const c of cases) {
    const truth = c.expected.needs_human.value;
    // A case the model never answered is NOT flagged: a silent miss is exactly what recall must show.
    const predicted = c.output?.needs_human ?? false;
    if (truth && predicted) tp++;
    else if (!truth && predicted) fp++;
    else if (truth && !predicted) fn++;
    else tn++;
  }
  const spans = cases.reduce((a, c) => a + c.mentionSpans, 0);
  const fabricated = cases.reduce((a, c) => a + c.fabricatedSpans, 0);
  const attempts = cases.reduce((a, c) => a + c.attempts, 0);
  const invalid = cases.reduce((a, c) => a + c.invalidAttempts, 0);
  const latencies = cases.flatMap((c) => c.latenciesMs);
  return {
    messages: n,
    answered: answered.length,
    intent: hits((c) => c.output?.intent === c.expected.intent.value),
    sentiment_decision: hits(
      (c) => c.output?.sentiment_decision === c.expected.sentiment_decision.value,
    ),
    materials: hits(
      (c) =>
        c.output !== undefined && sameMaterials(c.output.materials, c.expected.materials.value),
    ),
    needsHuman: {
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      trueNegatives: tn,
    },
    fabricationRate: ratio(fabricated, spans),
    casesWithFabrication: cases.filter((c) => c.fabricatedSpans > 0).length,
    validationFailureRate: ratio(invalid, attempts) ?? 0,
    medianLatencyMs: latencies.length > 0 ? percentile(latencies, 50) : null,
    p95LatencyMs: latencies.length > 0 ? percentile(latencies, 95) : null,
    constrainedDecoding: cases.some((c) => c.constrained),
  };
}

/** What constant answers would score: the numbers any accuracy figure has to be read against. */
export interface Baselines {
  messages: number;
  intentClasses: Record<string, number>;
  majorityIntent: { intent: string; count: number; share: number } | null;
  majoritySentiment: { value: string; share: number } | null;
  needsHumanPositives: number;
  /** Always answering "no human needed". */
  alwaysNoHumanAccuracy: number;
  /** One case, as a share of the score. */
  oneCase: number;
}

export function baselines(golden: readonly GoldenFile[]): Baselines {
  const n = golden.length;
  const count = (f: (g: GoldenFile) => string): [string, number][] => {
    const m = new Map<string, number>();
    for (const g of golden) m.set(f(g), (m.get(f(g)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const intents = count((g) => g.expected.intent.value);
  const sentiments = count((g) => g.expected.sentiment_decision.value);
  const positives = golden.filter((g) => g.expected.needs_human.value).length;
  return {
    messages: n,
    intentClasses: Object.fromEntries(intents),
    majorityIntent: intents[0]
      ? { intent: intents[0][0], count: intents[0][1], share: intents[0][1] / n }
      : null,
    majoritySentiment: sentiments[0]
      ? { value: sentiments[0][0], share: sentiments[0][1] / n }
      : null,
    needsHumanPositives: positives,
    alwaysNoHumanAccuracy: n === 0 ? 0 : (n - positives) / n,
    oneCase: n === 0 ? 0 : 1 / n,
  };
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const ms = (x: number | null): string =>
  x === null ? 'n/a' : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${x.toFixed(0)} ms`;

export interface ReportInput {
  date: string;
  dir: string;
  source: string;
  seededBy: string[];
  baselines: Baselines;
  scores: { model: string; score: ModelScore }[];
}

/** The report, with the baseline and the corpus size next to the numbers, as the spec requires. */
export function renderReport(r: ReportInput): string {
  const b = r.baselines;
  const classes = Object.entries(b.intentClasses)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(', ');
  const lines = [
    `# Triage eval (${r.date})`,
    '',
    `Golden set: \`${r.dir}\` (${r.source}), **${String(b.messages)} messages**, every label verified. Escalation is disabled: each model runs alone on a one-rung ladder, with the same prompt and the same redaction as production. Prompt plus validate plus retry (no constrained decoding on Ollama Cloud).`,
    '',
    `**Labels seeded by:** ${r.seededBy.join(', ')}. A set seeded from one model's output anchors on that model; what limits it is that a human verified every field and that this eval measures *other* models against it.`,
    '',
    '## Corpus',
    '',
    `- Messages per intent: ${classes}.`,
    `- **Majority-class baseline for intent: ${b.majorityIntent ? `${pct(b.majorityIntent.share)} (always answering \`${b.majorityIntent.intent}\`, ${String(b.majorityIntent.count)} of ${String(b.messages)})` : 'n/a'}.** Read every intent accuracy below against it.`,
    `- Majority baseline for sentiment_decision: ${b.majoritySentiment ? `${pct(b.majoritySentiment.share)} (\`${b.majoritySentiment.value}\`)` : 'n/a'}.`,
    `- \`needs_human\` is true for ${String(b.needsHumanPositives)} of ${String(b.messages)}; always answering "no human needed" scores ${pct(b.alwaysNoHumanAccuracy)} accuracy with 0% recall.`,
    `- **With ${String(b.messages)} messages, one case is ${pct(b.oneCase)} of a score.** Differences of one or two cases are noise.`,
    '',
    '## Per model',
    '',
    '| Model | intent | sentiment_decision | materials | needs_human precision | needs_human recall | fabricated spans | validation failures | median | p95 | constrained |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...r.scores.map(
      ({ model, score: s }) =>
        `| ${model} | ${pct(s.intent)} | ${pct(s.sentiment_decision)} | ${pct(s.materials)} | ${pct(s.needsHuman.precision)} | ${pct(s.needsHuman.recall)} | ${pct(s.fabricationRate)} (${String(s.casesWithFabrication)} msg) | ${pct(s.validationFailureRate)} | ${ms(s.medianLatencyMs)} | ${ms(s.p95LatencyMs)} | ${s.constrainedDecoding ? 'yes' : 'no'} |`,
    ),
    '',
    'Columns: accuracy is correct over all messages (a message with no valid answer counts as wrong); `materials` is an exact match of all four flags; fabricated spans are `mentions` entries that are not a verbatim span of the text the model was given (substring search in code, on the first valid answer, so the eval sees what production would refuse and retry); validation failures are failed validations over all attempts, retries included.',
    '',
    '### needs_human, in counts',
    '',
    '| Model | caught (TP) | false alarms (FP) | missed (FN) | correctly quiet (TN) | no valid answer |',
    '|---|---|---|---|---|---|',
    ...r.scores.map(
      ({ model, score: s }) =>
        `| ${model} | ${String(s.needsHuman.truePositives)} | ${String(s.needsHuman.falsePositives)} | ${String(s.needsHuman.falseNegatives)} | ${String(s.needsHuman.trueNegatives)} | ${String(s.messages - s.answered)} |`,
    ),
    '',
    'A missed "I am not sure" is a silent wrong answer; a model that always flags is useless. Both columns matter.',
    '',
  ];
  return lines.join('\n');
}
