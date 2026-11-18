import {
  ConfigError,
  type AppConfig,
  parseModelRef,
  formatModelRef,
} from '../config/env.schema.js';

/**
 * The only read-only scope. No send, compose or modify scope is requested anywhere in this repository:
 * an accidental send is not merely forbidden but impossible. M4b widens it deliberately, and only to
 * the compose scope. (A source scan in test/unit/inbox-scope-config.test.ts keeps it that way.)
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'] as const;

export interface InboxConfig {
  /** Full-trust label name. */
  label: string;
  /** Metadata-only label name. */
  candidateLabel: string;
  triageStartRung: number;
  triageMaxChars: number;
  sweepMaxPages: number;
  threadSweepDays: number;
  threadSweepMax: number;
}

/**
 * Validated when the inbox boots, never defaulted: an unset label must fail loudly, not quietly mean
 * "everything". The two labels must differ (comparison ignores case, as Gmail does), because the
 * difference between them is the whole access-control model.
 */
export function resolveInboxConfig(config: AppConfig): InboxConfig {
  const problems: string[] = [];
  const label = config.GMAIL_LABEL;
  const candidate = config.GMAIL_CANDIDATE_LABEL;
  if (label === undefined)
    problems.push('GMAIL_LABEL: required, no default (the label that admits mail)');
  if (candidate === undefined)
    problems.push('GMAIL_CANDIDATE_LABEL: required, no default (the metadata-only label)');
  if (
    label !== undefined &&
    candidate !== undefined &&
    label.toLowerCase() === candidate.toLowerCase()
  ) {
    problems.push(
      'GMAIL_LABEL and GMAIL_CANDIDATE_LABEL must differ: they are two levels of trust',
    );
  }
  const start = parseModelRef(config.TRIAGE_START_MODEL);
  let triageStartRung = 0;
  if (typeof start === 'string') {
    problems.push(`TRIAGE_START_MODEL: ${start}`);
  } else {
    const idx = config.LLM_MODEL_LADDER.findIndex(
      (r) => formatModelRef(r) === formatModelRef(start),
    );
    if (idx === -1) {
      problems.push(
        `TRIAGE_START_MODEL: ${formatModelRef(start)} is not in LLM_MODEL_LADDER (${config.LLM_MODEL_LADDER.map(formatModelRef).join(', ')})`,
      );
    } else triageStartRung = idx;
  }
  if (problems.length > 0 || label === undefined || candidate === undefined) {
    throw new ConfigError(problems);
  }
  return {
    label,
    candidateLabel: candidate,
    triageStartRung,
    triageMaxChars: config.TRIAGE_MAX_CHARS,
    sweepMaxPages: config.GMAIL_SWEEP_MAX_PAGES,
    threadSweepDays: config.INBOX_THREAD_SWEEP_DAYS,
    threadSweepMax: config.INBOX_THREAD_SWEEP_MAX,
  };
}

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** For the real Gmail adapter only. Lists the NAMES that are missing, never a value. */
export function requireGmailCredentials(config: AppConfig): GmailCredentials {
  const missing = (
    ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'] as const
  ).filter((k) => config[k] === undefined);
  if (
    missing.length > 0 ||
    config.GMAIL_CLIENT_ID === undefined ||
    config.GMAIL_CLIENT_SECRET === undefined ||
    config.GMAIL_REFRESH_TOKEN === undefined
  ) {
    throw new ConfigError(
      missing.map((k) => `${k}: required to read Gmail (run: npm run inbox -- auth)`),
    );
  }
  return {
    clientId: config.GMAIL_CLIENT_ID,
    clientSecret: config.GMAIL_CLIENT_SECRET,
    refreshToken: config.GMAIL_REFRESH_TOKEN,
  };
}
