import { isForbiddenFolder } from './folders.js';
import { parseSenderList } from './rules.js';
import {
  ConfigError,
  type AppConfig,
  parseModelRef,
  formatModelRef,
} from '../config/env.schema.js';

export interface InboxConfig {
  /** Full-trust label name. */
  label: string;
  /** Metadata-only label name. */
  candidateLabel: string;
  triageStartRung: number;
  triageMaxChars: number;
  /** The most of a body that is stored (INBOX_BODY_MAX_CHARS). */
  bodyMaxChars: number;
  /** The most one message's triage may take across the ladder (TRIAGE_MESSAGE_DEADLINE_MS). */
  triageDeadlineMs: number;
  /** Pages of GMAIL_SWEEP_PAGE_SIZE UIDs one poll may read per folder: bounds a backfill or a re-sweep. */
  sweepMaxPages: number;
  sweepPageSize: number;
  /** Senders (addresses, or `@domain`) whose mail is `document_share` with no model call. Lower-cased. */
  documentShareSenders: string[];
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
  for (const [name, value] of [
    ['GMAIL_LABEL', label],
    ['GMAIL_CANDIDATE_LABEL', candidate],
  ] as const) {
    if (value !== undefined && isForbiddenFolder(value)) {
      problems.push(
        `${name}: "${value}" is INBOX or a [Gmail] system folder (All Mail, Sent, ...): it holds the whole mailbox, not a label, and is never opened`,
      );
    }
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
    bodyMaxChars: config.INBOX_BODY_MAX_CHARS,
    triageDeadlineMs: config.TRIAGE_MESSAGE_DEADLINE_MS,
    sweepMaxPages: config.GMAIL_SWEEP_MAX_PAGES,
    sweepPageSize: config.GMAIL_SWEEP_PAGE_SIZE,
    documentShareSenders: parseSenderList(config.INBOX_DOCUMENT_SHARE_SENDERS),
  };
}

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  appPassword: string;
}

/** For the real adapter only. Lists the NAMES that are missing, never a value. */
export function requireImapCredentials(config: AppConfig): ImapCredentials {
  if (config.IMAP_USER === undefined || config.IMAP_APP_PASSWORD === undefined) {
    const missing = [
      ...(config.IMAP_USER === undefined ? ['IMAP_USER'] : []),
      ...(config.IMAP_APP_PASSWORD === undefined ? ['IMAP_APP_PASSWORD'] : []),
    ];
    throw new ConfigError(
      missing.map((k) => `${k}: required to read Gmail (an app password: see README, "Inbox")`),
    );
  }
  return {
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    user: config.IMAP_USER,
    appPassword: config.IMAP_APP_PASSWORD,
  };
}
