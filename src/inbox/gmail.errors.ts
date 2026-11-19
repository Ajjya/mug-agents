/**
 * What a failed IMAP call is allowed to leave behind (spec 4: "never in an error message or a thrown
 * error's properties"). IMAP libraries echo the command that failed, and for a failed login that command
 * is `LOGIN "user" "app-password"` (or an AUTHENTICATE PLAIN line carrying the same pair in base64).
 * Anything that prints such an error with util.inspect, a logger or JSON.stringify prints those too.
 *
 * So the original error is never wrapped, never attached as `cause`, and none of its properties are copied:
 * a NEW error is built from an operation name and a message (the library's own text and the server's
 * response text) from which every known secret, and every credential-shaped string, has been scrubbed.
 */
export class GmailTransportError extends Error {
  constructor(
    public readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = 'GmailTransportError';
  }
}

/** Credential shapes, scrubbed even when the caller did not list the secret (a rotated password, say). */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\b(?:LOGIN|AUTHENTICATE\s+PLAIN|AUTHENTICATE\s+LOGIN)\s+[^\r\n]+/gi, // the echoed command and its arguments
  /\bAUTH(?:ENTICATE)?\s+(?:PLAIN\s+)?[A-Za-z0-9+/=]{16,}/gi,
  /\b[A-Za-z0-9+/]{20,}={0,2}(?=\s|$)/g, // a long base64 run: an AUTH PLAIN payload
  /\b[a-z]{4}(?:\s?[a-z]{4}){3}\b/g, // a 16-letter app password, grouped or not
  /Bearer\s+[\w.~+/=-]+/gi,
];

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  for (const re of TOKEN_SHAPES) out = out.replace(re, '[redacted]');
  return out;
}

/** The server's answer to a failed command, when the library kept one (it can echo the command). */
function responseTextOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const t = (err as { responseText?: unknown }).responseText;
  return typeof t === 'string' ? `\n${t}` : '';
}

export function sanitizeTransportError(
  operation: string,
  err: unknown,
  secrets: readonly string[],
): GmailTransportError {
  const raw =
    err instanceof Error
      ? err.message + responseTextOf(err)
      : typeof err === 'string'
        ? err
        : 'unrecognised error object';
  return new GmailTransportError(
    operation,
    `${operation} failed: ${scrub(raw, secrets).slice(0, 300)}`,
  );
}
