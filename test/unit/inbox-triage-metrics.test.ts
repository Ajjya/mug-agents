import { describe, expect, it } from 'vitest';
import { loadGolden } from '../../src/inbox/golden.js';
import {
  type CaseResult,
  baselines,
  renderReport,
  scoreModel,
} from '../../src/inbox/triage.metrics.js';
import type { TriageOutput } from '../../src/inbox/triage.schema.js';

const NO = { abstract: false, bio: false, photo: false, slides: false };
const v = <T>(value: T) => ({ value, status: 'verified' as const });

const out = (over: Partial<TriageOutput> = {}): TriageOutput => ({
  intent: 'speaker_reply',
  sentiment_decision: 'accepts',
  mentions: { dates: [], people: [], organisations: [] },
  materials: NO,
  asks: [],
  needs_human: false,
  reason: '',
  confidence: 'high',
  ...over,
});

const c = (
  over: Partial<CaseResult> & { expectIntent?: string; expectNH?: boolean } = {},
): CaseResult => ({
  id: 'x',
  expected: {
    intent: v((over.expectIntent ?? 'speaker_reply') as never),
    sentiment_decision: v('accepts' as const),
    materials: v(NO),
    needs_human: v(over.expectNH ?? false),
  },
  output: out(),
  fabricatedSpans: 0,
  mentionSpans: 0,
  attempts: 1,
  invalidAttempts: 0,
  latenciesMs: [100],
  constrained: false,
  ...over,
});

describe('scoreModel', () => {
  it('per-field accuracy over ALL messages: a message with no valid answer is wrong', () => {
    const s = scoreModel([
      c({ output: out({ intent: 'speaker_reply' }) }),
      c({ output: out({ intent: 'other' }) }),
      c({ output: undefined, invalidAttempts: 2, attempts: 2 }),
      c({ output: out({ intent: 'speaker_reply' }) }),
    ]);
    expect(s.messages).toBe(4);
    expect(s.answered).toBe(3);
    expect(s.intent).toBe(0.5); // 2 of 4
  });

  it('materials is an exact match of all four flags', () => {
    const s = scoreModel([
      c({ output: out({ materials: NO }) }),
      c({ output: out({ materials: { ...NO, bio: true } }) }), // one flag wrong: the whole object is wrong
    ]);
    expect(s.materials).toBe(0.5);
  });

  it('needs_human precision and recall, from counts you can check by eye', () => {
    // truth: T T T F F F F ; predicted: T T F T F F F  -> TP 2, FN 1, FP 1, TN 3
    const truth = [true, true, true, false, false, false, false];
    const pred = [true, true, false, true, false, false, false];
    const s = scoreModel(
      truth.map((t, i) =>
        c({
          expectNH: t,
          output: out({ needs_human: pred[i] ?? false, reason: pred[i] ? 'r' : '' }),
        }),
      ),
    );
    expect(s.needsHuman).toEqual({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 1,
      trueNegatives: 3,
      precision: 2 / 3,
      recall: 2 / 3,
    });
  });

  it('a message the model never answered is NOT flagged: a silent miss shows up as lost recall', () => {
    const s = scoreModel([
      c({ expectNH: true, output: undefined }),
      c({ expectNH: true, output: out({ needs_human: true, reason: 'r' }) }),
    ]);
    expect(s.needsHuman).toMatchObject({ truePositives: 1, falseNegatives: 1, recall: 0.5 });
  });

  it('a model that flags everything has recall 1 and visibly poor precision; one that flags nothing has recall 0', () => {
    const cases = (flag: boolean) =>
      [true, false, false, false].map((t) =>
        c({ expectNH: t, output: out({ needs_human: flag, reason: flag ? 'r' : '' }) }),
      );
    expect(scoreModel(cases(true)).needsHuman).toMatchObject({ recall: 1, precision: 0.25 });
    expect(scoreModel(cases(false)).needsHuman).toMatchObject({ recall: 0, precision: null }); // no positive predictions: precision undefined, not 0
  });

  it('no positives in the set makes recall undefined, not 1', () => {
    expect(scoreModel([c(), c()]).needsHuman.recall).toBeNull();
  });

  it('fabrication rate is spans not in the text over all spans, and counts the messages involved', () => {
    const s = scoreModel([
      c({ mentionSpans: 4, fabricatedSpans: 1 }),
      c({ mentionSpans: 2, fabricatedSpans: 1 }),
      c({ mentionSpans: 0 }),
    ]);
    expect(s.fabricationRate).toBeCloseTo(2 / 6);
    expect(s.casesWithFabrication).toBe(2);
    expect(scoreModel([c()]).fabricationRate).toBeNull(); // no spans: nothing to rate
  });

  it('validation failure rate is over ATTEMPTS, retries included', () => {
    const s = scoreModel([
      c({ attempts: 2, invalidAttempts: 1 }),
      c({ attempts: 1, invalidAttempts: 0 }),
      c({ attempts: 1, invalidAttempts: 0 }),
    ]);
    expect(s.validationFailureRate).toBe(0.25);
  });

  it('latency: median and p95 over every call; constrained if any call was', () => {
    const s = scoreModel([
      c({ latenciesMs: [100, 200] }),
      c({ latenciesMs: [300, 5000] }),
      c({ latenciesMs: [150] }),
    ]);
    expect(s.medianLatencyMs).toBe(200);
    expect(s.p95LatencyMs).toBeGreaterThan(300);
    expect(s.constrainedDecoding).toBe(false);
    expect(scoreModel([c({ constrained: true })]).constrainedDecoding).toBe(true);
    expect(scoreModel([c({ latenciesMs: [] })]).medianLatencyMs).toBeNull();
  });

  it('an empty set is all zeros, not NaN', () => {
    const s = scoreModel([]);
    expect([s.intent, s.materials, s.validationFailureRate]).toEqual([0, 0, 0]);
  });
});

describe('baselines (what a constant answer scores)', () => {
  const sample = loadGolden('corpus/sample/inbox-golden').map((g) => g.golden);
  it('the committed sample: speaker_reply is the majority class at 33%, one case is 7%', () => {
    const b = baselines(sample);
    expect(b.messages).toBe(15);
    expect(b.majorityIntent).toEqual({ intent: 'speaker_reply', count: 5, share: 5 / 15 });
    expect(b.oneCase).toBeCloseTo(1 / 15);
    expect(b.needsHumanPositives).toBe(2);
    expect(b.alwaysNoHumanAccuracy).toBeCloseTo(13 / 15);
  });

  it('a model that always answers the majority class scores exactly the baseline', () => {
    const b = baselines(sample);
    const always = sample.map((g) =>
      c({ expected: g.expected, output: out({ intent: 'speaker_reply' }) }),
    );
    expect(scoreModel(always).intent).toBe(b.majorityIntent?.share);
  });
});

describe('renderReport', () => {
  const sample = loadGolden('corpus/sample/inbox-golden').map((g) => g.golden);
  const report = renderReport({
    date: '2026-11-18',
    dir: 'corpus/sample/inbox-golden',
    source: 'fictional',
    seededBy: ['hand'],
    baselines: baselines(sample),
    scores: [
      {
        model: 'ollama:gpt-oss:20b',
        score: scoreModel(sample.map((g) => c({ expected: g.expected }))),
      },
    ],
  });

  it('states the corpus size, the per-class counts and the majority-class baseline next to the numbers', () => {
    expect(report).toContain('**15 messages**');
    expect(report).toContain('speaker_reply 5');
    expect(report).toMatch(
      /\*\*Majority-class baseline for intent: 33% \(always answering `speaker_reply`, 5 of 15\)/,
    );
    expect(report).toContain('one case is 7% of a score');
  });
  it('says which model seeded the labels, that escalation is off and that decoding is not constrained', () => {
    expect(report).toContain('**Labels seeded by:** hand');
    expect(report).toMatch(/Escalation is disabled/);
    expect(report).toMatch(/no constrained decoding on Ollama Cloud/);
  });
  it('has a row per model and the needs_human counts', () => {
    expect(report).toContain('| ollama:gpt-oss:20b |');
    expect(report).toMatch(/needs_human, in counts/);
  });
});
