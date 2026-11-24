/**
 * Removes the duplicate LinkedIn URL from a speaker seed FILE, as TEXT. The file format has one source:
 * `links.linkedin` is what a person writes, and the loader routes it into `handles.linkedin`. A file that
 * also carries `handles.linkedin` with the SAME value holds two copies that can drift: this removes the
 * copy in `handles` and changes nothing else, byte for byte (key order, indentation, diacritics and
 * percent-encoding in URLs are all untouched), because it edits the text, never a parsed and re-printed
 * document. Where the two values DIFFER nothing is removed and the speaker is reported: that is yours to fix.
 */

interface Node {
  kind: 'object' | 'array' | 'string' | 'other';
  start: number;
  end: number;
  value?: string;
  members?: Member[];
  items?: Node[];
}
interface Member {
  key: string;
  start: number; // the key's opening quote
  end: number; // the end of the value
  value: Node;
}

/** A position-aware reader for JSON. Strict enough for a seed file; anything odd is an error. */
function parse(text: string): Node {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
  };
  const fail = (msg: string): never => {
    throw new SyntaxError(`${msg} at offset ${String(i)}`);
  };
  const string = (): Node => {
    const start = i;
    if (text.charAt(i) !== '"') fail('expected a string');
    i++;
    while (i < text.length && text.charAt(i) !== '"') i += text.charAt(i) === '\\' ? 2 : 1;
    if (i >= text.length) fail('unterminated string');
    i++;
    return {
      kind: 'string',
      start,
      end: i,
      value: JSON.parse(text.slice(start, i)) as string,
    };
  };
  const value = (): Node => {
    ws();
    const c = text.charAt(i);
    if (c === '{') {
      const start = i++;
      const members: Member[] = [];
      ws();
      if (text.charAt(i) === '}') return { kind: 'object', start, end: ++i, members };
      for (;;) {
        ws();
        const k = string();
        ws();
        if (text.charAt(i++) !== ':') fail('expected ":"');
        const v = value();
        members.push({ key: k.value ?? '', start: k.start, end: v.end, value: v });
        ws();
        const d = text.charAt(i++);
        if (d === '}') return { kind: 'object', start, end: i, members };
        if (d !== ',') fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      const start = i++;
      const items: Node[] = [];
      ws();
      if (text.charAt(i) === ']') return { kind: 'array', start, end: ++i, items };
      for (;;) {
        items.push(value());
        ws();
        const d = text.charAt(i++);
        if (d === ']') return { kind: 'array', start, end: i, items };
        if (d !== ',') fail('expected "," or "]"');
      }
    }
    if (c === '"') return string();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) return fail('unexpected character');
    const start = i;
    i += m[0].length;
    return { kind: 'other', start, end: i };
  };
  const root = value();
  ws();
  if (i !== text.length) fail('trailing content');
  return root;
}

const member = (o: Node | undefined, key: string): Member | undefined =>
  o?.kind === 'object' ? o.members?.find((m) => m.key === key) : undefined;

export interface SeedCleanResult {
  /** The new text; identical to the input when nothing was removed or when there are conflicts. */
  text: string;
  /** Speakers whose duplicate `handles.linkedin` was (or would be) removed. */
  removed: string[];
  /** Speakers whose two values differ: nothing is touched in the file while any exist. */
  conflicts: { speaker: string; links: string; handles: string }[];
}

export function cleanSpeakerSeed(text: string): SeedCleanResult {
  const root = parse(text);
  const speakers = member(root, 'speakers')?.value;
  if (speakers?.kind !== 'array') throw new SyntaxError('the seed file has no "speakers" array');
  const items = speakers.items ?? [];
  const removed: string[] = [];
  const conflicts: SeedCleanResult['conflicts'] = [];
  const cuts: [number, number][] = [];
  for (const sp of items) {
    const name =
      member(sp, 'handle')?.value.value ?? member(sp, 'name')?.value.value ?? '(unnamed)';
    const fromLinks = member(member(sp, 'links')?.value, 'linkedin')?.value.value;
    const handlesMember = member(sp, 'handles');
    const handleLinkedin = member(handlesMember?.value, 'linkedin');
    if (fromLinks === undefined || handleLinkedin === undefined || !handlesMember) continue;
    const dup = handleLinkedin.value.value;
    if (dup !== fromLinks) {
      conflicts.push({ speaker: name, links: fromLinks, handles: dup ?? '' });
      continue;
    }
    removed.push(name);
    const inner = handlesMember.value.members ?? [];
    // The only key in `handles`: the (now empty) member goes with it, from the speaker's point of view.
    if (inner.length === 1) cuts.push(cutMember(sp.members ?? [], handlesMember));
    else cuts.push(cutMember(inner, handleLinkedin));
  }
  if (conflicts.length > 0 || cuts.length === 0) return { text, removed: [], conflicts };
  let out = text;
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  return { text: out, removed, conflicts: [] };
}

/** The text span to delete so `target` leaves its sibling list well formed, touching nothing else. */
function cutMember(siblings: readonly Member[], target: Member): [number, number] {
  const at = siblings.indexOf(target);
  const next = siblings[at + 1];
  const prev = siblings[at - 1];
  if (next) return [target.start, next.start]; // `"k": v,<whitespace>` goes; the next key keeps its place
  if (prev) return [prev.end, target.end]; // last member: the preceding comma goes with it
  return [target.start, target.end];
}
