import { type Address, AddressSchema } from '../domain/inbox.schema.js';

/** `Name <a@b>`, `"Last, First" <a@b>` or a bare `a@b` -> an Address, or null when there is none. */
export function parseAddress(header: string | undefined): Address | null {
  if (!header) return null;
  const angle = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(header);
  const candidate = (angle ? angle[2] : header)?.trim() ?? '';
  const name = angle?.[1]?.trim();
  const parsed = AddressSchema.safeParse({ address: candidate, ...(name ? { name } : {}) });
  return parsed.success ? parsed.data : null;
}

/** A comma-separated recipient header. Unparseable entries are dropped. */
export function parseAddressList(header: string | undefined): Address[] {
  if (!header) return [];
  // Split on commas that are outside quotes and angle brackets.
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') depth++;
    if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !quoted && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.flatMap((p) => {
    const a = parseAddress(p);
    return a ? [a] : [];
  });
}

/** What stands in when a message has no parseable sender. Never a real address. */
export const UNKNOWN_SENDER: Address = { address: 'unknown@unknown.invalid' };
