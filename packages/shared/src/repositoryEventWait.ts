/**
 * Reading and waiting on the repository change-event journal
 * (`repository_events`), shared by the REST API
 * (`GET /api/repository-events`, `GET /api/repository-events/wait`), MCP
 * `list_repository_events` / `wait_repository_events` and
 * `propr events list|wait`.
 *
 * Delivery is at-least-once and ordered by the journal's `seq`. A client keeps
 * the cursor of the last event it processed and passes it back as
 * `afterCursor`; it never sees an event twice unless it resumes from an older
 * cursor, and it never misses one unless its cursor expired (which is reported
 * as `CURSOR_EXPIRED`, never as an empty result).
 */
import { REPOSITORY_EVENT_DOMAINS, REPOSITORY_EVENT_TYPES, type RepositoryEventDomain } from './repositoryEvents.js';

/** Seconds one wait request may block. A request never waits longer than the maximum. */
export const REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS = 15;
export const REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS = 30;
/** Events one list or wait returns at most. */
export const REPOSITORY_EVENT_LIST_DEFAULT_LIMIT = 50;
export const REPOSITORY_EVENT_LIST_MAX_LIMIT = 100;
/** Distinct `types` values one request may filter on. */
export const REPOSITORY_EVENT_MAX_TYPE_FILTERS = 20;

export const REPOSITORY_EVENT_WAIT_OUTCOMES = ['events', 'timeout'] as const;
export type RepositoryEventWaitOutcome = (typeof REPOSITORY_EVENT_WAIT_OUTCOMES)[number];

/** Every event type of every domain, deduplicated, in declaration order. */
export const REPOSITORY_EVENT_ALL_TYPES: readonly string[] = [...new Set(
  REPOSITORY_EVENT_DOMAINS.flatMap(domain => REPOSITORY_EVENT_TYPES[domain]),
)];

/** Machine-readable failures of a list or wait, with their recovery instructions. */
export const REPOSITORY_EVENT_ERRORS = {
  CURSOR_INVALID: 'The cursor is malformed or was not issued by this instance. First list once without afterCursor and save the returned cursor, then re-read the state you care about, then resume from the saved cursor.',
  CURSOR_WRONG_REPOSITORY: 'The cursor belongs to a different repository. Use a cursor returned for this repository, or omit afterCursor.',
  CURSOR_EXPIRED: 'The cursor is older than the retained journal, so events after it may have been pruned. First list once without afterCursor and save the returned cursor, then re-read the state you care about (for example get_pull_request_readiness), then resume from the saved cursor so no change made during the re-read is missed.',
  WAIT_LIMIT: 'Let an existing wait finish or cancel it before starting another. The limit counts CLI, REST and MCP repository event waits together.',
  WAIT_ABORTED: 'The wait was cancelled by the caller. Nothing changed; wait again with the same cursor.',
  INVALID_INPUT: 'Correct the request parameters and retry.',
} as const;
export type RepositoryEventErrorCode = keyof typeof REPOSITORY_EVENT_ERRORS;
export type RepositoryEventCursorErrorCode = 'CURSOR_INVALID' | 'CURSOR_WRONG_REPOSITORY' | 'CURSOR_EXPIRED';

/** One journal event as list and wait return it. `cursor` resumes immediately after this event. */
export interface RepositoryEventView {
  cursor: string;
  domain: RepositoryEventDomain;
  type: string;
  repository: string;
  pullRequest?: number;
  issueNumber?: number;
  planId?: string;
  /** PR number, epic execution id, or plan issue id, as text. */
  entityId: string;
  /** Head SHA the event was recorded for, when it concerns one. */
  head?: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface RepositoryEventListResult {
  events: RepositoryEventView[];
  /** Resume point: after the last returned event, or the starting position when none was returned. */
  cursor: string;
  /** More matching events exist after `cursor`; list again with it. */
  truncated: boolean;
}

export interface RepositoryEventWaitResult extends RepositoryEventListResult {
  outcome: RepositoryEventWaitOutcome;
  waitedMs: number;
  timeoutSeconds: number;
}

const CURSOR_PREFIX = 'rec1.';
const MAX_CURSOR_LENGTH = 512;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('not base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

const MAX_GENERATION_LENGTH = 64;

/**
 * Opaque cursor for a repository's journal position: `rec1.` + base64url of
 * `{r, s}`. A position inside retained history below the retention floor (a
 * `fromStart` page) also carries `g`, the retention generation it was issued
 * under, so it stays resumable until retention next prunes the repository.
 */
export function encodeRepositoryEventCursor(repository: string, seq: number, generation?: string): string {
  const body = generation ? { r: repository, s: seq, g: generation } : { r: repository, s: seq };
  return CURSOR_PREFIX + toBase64Url(JSON.stringify(body));
}

export type DecodedRepositoryEventCursor =
  | { ok: true; repository: string; seq: number; generation?: string }
  | { ok: false; code: 'CURSOR_INVALID' | 'CURSOR_WRONG_REPOSITORY' };

/**
 * Parse a cursor's shape and its repository binding (case-insensitive, as
 * GitHub repository names are). Whether the position is still retained is
 * checked against the journal.
 */
export function decodeRepositoryEventCursor(cursor: unknown, repository: string): DecodedRepositoryEventCursor {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX) || cursor.length > MAX_CURSOR_LENGTH) {
    return { ok: false, code: 'CURSOR_INVALID' };
  }
  let parsed: { r?: unknown; s?: unknown; g?: unknown };
  try { parsed = JSON.parse(fromBase64Url(cursor.slice(CURSOR_PREFIX.length))); }
  catch { return { ok: false, code: 'CURSOR_INVALID' }; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.r !== 'string' || !parsed.r.includes('/')
    || typeof parsed.s !== 'number' || !Number.isSafeInteger(parsed.s) || parsed.s < 0
    || (parsed.g !== undefined && (typeof parsed.g !== 'string' || parsed.g.length > MAX_GENERATION_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(parsed.g)))) {
    return { ok: false, code: 'CURSOR_INVALID' };
  }
  if (parsed.r.toLowerCase() !== repository.toLowerCase()) return { ok: false, code: 'CURSOR_WRONG_REPOSITORY' };
  return { ok: true, repository: parsed.r, seq: parsed.s, ...(typeof parsed.g === 'string' ? { generation: parsed.g } : {}) };
}

export function isRepositoryEventDomain(value: unknown): value is RepositoryEventDomain {
  return typeof value === 'string' && (REPOSITORY_EVENT_DOMAINS as readonly string[]).includes(value);
}

export function isKnownRepositoryEventType(value: unknown): boolean {
  return typeof value === 'string' && REPOSITORY_EVENT_ALL_TYPES.includes(value);
}

/** Clamp a requested timeout into the per-request bounds; rejects non-numbers and out-of-range values. */
export function normalizeRepositoryEventWaitTimeoutSeconds(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS) return null;
  return parsed;
}
