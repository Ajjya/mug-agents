import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { POLICY } from '../../test/support/speakers-harness.js';
import { reportTable, runScenarios } from './scenarios.js';

/**
 * npm run eval:speakers. No network, no database, no model: the question is which path the graph
 * took, so the model is scripted (behind the real validation and ladder) and the clock is frozen.
 */
async function main(): Promise<number> {
  const results = await runScenarios();
  const table = reportTable(results);
  const passed = results.filter((r) => r.pass).length;
  const date = new Date().toISOString().slice(0, 10);
  const body = [
    `# Speakers agent: trajectory evals (${date})`,
    '',
    `Frozen clock, scripted model behind the real structured-call validation and ladder, in-memory storage and checkpointer. Event day: Saturday 12 December 2026. Policy: CHASE_MAX_ROUNDS ${String(POLICY.chaseMaxRounds)}, CHASE_MIN_INTERVAL_DAYS ${String(POLICY.chaseMinIntervalDays)}, MAX_DRAFTS_PER_RUN ${String(POLICY.maxDraftsPerRun)}.`,
    '',
    'A path has one step per run (`MM-DD what was drafted or tasked`, `-` for nothing). Human actions between runs (approve, sent, status) are not steps.',
    '',
    table,
    '',
    `**${String(passed)}/${String(results.length)} scenarios pass.**`,
    '',
    '## What this harness does not cover',
    '',
    '- The wording of any message: the model is scripted. Whether a real model writes a good invitation is not measured here.',
    '- A real model failing validation repeatedly (ladder exhaustion): covered by the structured-call unit tests, not by a trajectory.',
    "- Retrieval quality for the drafting context: the context is stubbed; M3's retrieval eval covers search.",
    '- Real cross-process resume on MongoDB: "Resume mid-approval" uses a second runtime on a shared in-memory checkpointer; the MongoDB-checkpointer version is in test/integration/speakers.workflow.test.ts.',
    '',
  ].join('\n');
  const out = fileURLToPath(new URL(`../../../evals/speakers/report-${date}.md`, import.meta.url));
  await writeFile(out, body);
  console.log(table);
  console.log(`\n${String(passed)}/${String(results.length)} pass. Written to ${out}`);
  return passed === results.length ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
