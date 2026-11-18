/**
 * What a failed Gmail or OAuth call is allowed to leave behind (spec 4: "never in an error message or a
 * thrown error's properties"). The HTTP layer's own errors carry the whole request: the form body of a
 * token exchange (the refresh token and the client secret), the Authorization header, and the response.
 * Anything that prints such an error with util.inspect, a logger or JSON.stringify prints those too.
 *
 * So the original error is never wrapped, never attached as `cause`, and none of its properties are copied:
 * a NEW error is built from an operation name, an HTTP status and a message from which every known
 * secret, and every token-shaped string, has been scrubbed.
 */
export class GmailTransportError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'GmailTransportError';
  }
}

/** Token shapes, scrubbed even when the caller did not list the secret (a rotated token, say). */
const TOKEN_SHAPES: readonly RegExp[] = [
  /ya29\.[\w-]+/g, // Google access tokens
  /1\/\/[\w-]{20,}/g, // Google refresh tokens
  /GOCSPX-[\w-]+/g, // Google client secrets
  /Bearer\s+[\w.~+/=-]+/gi,
  /\b(refresh_token|client_secret|access_token|id_token|code_verifier|code)=[^&\s"']+/gi,
];

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  for (const re of TOKEN_SHAPES)
    out = out.replace(re, (m) =>
      m.includes('=') ? `${m.split('=')[0] ?? ''}=[redacted]` : '[redacted]',
    );
  return out;
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e.status, e.code, e.response?.status]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

export function sanitizeTransportError(
  operation: string,
  err: unknown,
  secrets: readonly string[],
): GmailTransportError {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unrecognised error object';
  const status = statusOf(err);
  return new GmailTransportError(
    operation,
    status,
    `${operation} failed${status === undefined ? '' : ` (HTTP ${String(status)})`}: ${scrub(raw, secrets).slice(0, 300)}`,
  );
}
