import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { cleanSpeakerSeed } from '../src/retrieval/clean-speaker-seed.js';

/**
 * `npm run clean-speaker-seed -- --corpus corpus/private`
 *
 * Rewrites `<corpus>/speakers.seed.json` IN PLACE, removing `handles.linkedin` where it is identical to
 * `links.linkedin` (the file's one source) and changing nothing else, byte for byte. Prints what it removed.
 * A no-op on a second run. If any speaker's two values DIFFER it refuses to touch the file and lists them.
 */
const { values } = parseArgs({ options: { corpus: { type: 'string' } } });
if (!values.corpus) {
  console.error('Usage: npm run clean-speaker-seed -- --corpus <dir>   (e.g. corpus/private)');
  process.exit(2);
}
const file = join(values.corpus, 'speakers.seed.json');
const before = await readFile(file, 'utf8');
const r = cleanSpeakerSeed(before);
if (r.conflicts.length > 0) {
  console.error(
    `NOT touching ${file}: ${String(r.conflicts.length)} speaker(s) have links.linkedin and handles.linkedin that DIFFER. Fix these by hand (keep one, in links.linkedin):`,
  );
  for (const c of r.conflicts) {
    console.error(
      `  ${c.speaker}\n    links.linkedin   ${c.links}\n    handles.linkedin ${c.handles}`,
    );
  }
  process.exit(1);
}
if (r.text === before) {
  console.log(`${file}: nothing to remove (no speaker carries LinkedIn twice).`);
} else {
  await writeFile(file, r.text);
  console.log(
    `${file}: removed handles.linkedin (identical to links.linkedin) for ${String(r.removed.length)} speaker(s):`,
  );
  for (const name of r.removed) console.log(`  ${name}`);
}
