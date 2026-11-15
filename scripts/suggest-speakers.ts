import { parseArgs } from 'node:util';
import { ProviderUnavailableError, StructuredOutputError } from '../src/llm/errors.js';
import { EmbeddingMismatchError, EmbeddingUnavailableError } from '../src/retrieval/embedder.js';
import { SpeakerSuggester } from '../src/retrieval/suggest-speakers.js';
import { runCli } from './cli.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { limit: { type: 'string', default: '3' } },
});
const topic = positionals.join(' ').trim();
if (!topic) {
  console.error('Usage: npm run suggest-speakers -- "change streams" [--limit 3]');
  process.exit(2);
}

runCli(
  async (app) => {
    const r = await app
      .get(SpeakerSuggester, { strict: false })
      .suggest(topic, { limit: Number(values.limit) });
    if (r.suggestions.length === 0) {
      console.log(r.message ?? `Nothing in the corpus matches "${topic}".`);
      return 0;
    }
    console.log(`Speakers for "${topic}" (every one grounded in the cited chunks):\n`);
    r.suggestions.forEach((s, i) => {
      console.log(`${String(i + 1)}. ${s.speaker.name}  (${s.speaker.id})`);
      console.log(`   ${s.reason}`);
      for (const c of s.citations) console.log(`   cites ${c.id}  [${c.kind}, ${c.date}]`);
    });
    return 0;
  },
  (err) => {
    if (err instanceof ProviderUnavailableError)
      return (console.error(`PROVIDER FAILURE (not a model failure): ${err.message}`), 3);
    if (err instanceof StructuredOutputError)
      return (console.error(`No grounded suggestion could be produced: ${err.message}`), 4);
    if (err instanceof EmbeddingUnavailableError || err instanceof EmbeddingMismatchError)
      return (console.error(err.message), 2);
    return undefined;
  },
);
