import { type OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { GMAIL_SCOPES } from './inbox.config.js';

/**
 * The OAuth flow Google documents for an installed (Desktop) app: the system browser, a loopback
 * redirect on 127.0.0.1, and PKCE with S256. (The copy-paste "out of band" flow is no longer
 * supported.) It asks for gmail.readonly and nothing else.
 *
 * `access_type=offline` and `prompt=consent` are what make Google return a refresh token. NOTE: while the
 * OAuth consent screen is in "Testing" status, that refresh token EXPIRES AFTER 7 DAYS (the gmail.readonly
 * scope is not exempt): publish the app ("In production") for a token that lasts.
 */
export function buildAuthUrl(client: OAuth2Client, codeChallenge: string, state: string): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [...GMAIL_SCOPES],
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    state,
  });
}

export type CallbackResult = { ok: true; code: string } | { ok: false; reason: string };

/** What the loopback server does with the browser's redirect. Pure, so it is tested without a server. */
export function parseCallback(url: string, expectedState: string): CallbackResult {
  const u = new URL(url, 'http://127.0.0.1');
  const error = u.searchParams.get('error');
  if (error) return { ok: false, reason: `Google returned an error: ${error}` };
  if (u.searchParams.get('state') !== expectedState) {
    return {
      ok: false,
      reason: 'the state did not match: this redirect was not started by this command',
    };
  }
  const code = u.searchParams.get('code');
  return code ? { ok: true, code } : { ok: false, reason: 'no authorization code in the redirect' };
}
