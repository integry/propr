/**
 * `GET /api/repository-events` and `GET /api/repository-events/wait`: cursor
 * reads and bounded waits on a repository's change-event journal, the REST
 * side of MCP `list_repository_events` / `wait_repository_events` and of
 * `propr events list|wait`. Errors answer with the `ErrorEnvelope`; the
 * recovery instruction of a journal error is its `hint`.
 */
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { loadMonitoredReposRaw } from '@propr/core';
import {
  REPOSITORY_EVENT_DOMAINS,
  REPOSITORY_EVENT_LIST_DEFAULT_LIMIT,
  REPOSITORY_EVENT_LIST_MAX_LIMIT,
  REPOSITORY_EVENT_MAX_TYPE_FILTERS,
  REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS,
  isKnownRepositoryEventType,
  isRepositoryEventDomain,
  normalizeRepositoryEventWaitTimeoutSeconds,
  type RepositoryEventDomain,
} from '@propr/shared';
import {
  handleGitHubRepositoryAccessError,
  resolveGitHubMetadataToken,
  verifyGitHubRepositoryAccess,
} from '../githubMetadataAuth.js';
import {
  RepositoryEventWaitError,
  listRepositoryEventsAfterCursor,
  waitForRepositoryEvents,
  type RepositoryEventListOptions,
} from '../services/repositoryEventWait.js';
import { validateRepository } from './validation.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface RepositoryEventRoutesDeps {
  db: Knex;
  /** Enabled configured repositories; the instance configuration unless a test injects one. */
  configuredRepositories?: () => Promise<string[]>;
  /** Proves the caller can read the repository on GitHub; throws a GitHub-status error otherwise. */
  verifyAccess?: (req: Request, repository: string) => Promise<void>;
  listEvents?: typeof listRepositoryEventsAfterCursor;
  waitForEvents?: typeof waitForRepositoryEvents;
}

type ParsedQuery = Omit<RepositoryEventListOptions, 'db'> & { timeoutSeconds: number };

class InvalidQuery extends Error {}

function single(query: Record<string, unknown>, name: string): string | undefined {
  const value = query[name];
  if (Array.isArray(value)) {
    if (value.length > 1) throw new InvalidQuery(`${name} may be given once.`);
    return typeof value[0] === 'string' && value[0].length ? value[0] : undefined;
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * `afterCursor` as given. Unlike {@link single}, a present but empty or
 * non-string value is not treated as absent: an absent cursor starts at the
 * current end of the journal, so collapsing a malformed one into "absent"
 * would hand back a later cursor that skips unread events.
 */
function cursor(query: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(query, 'afterCursor')) return undefined;
  const raw = query.afterCursor;
  if (Array.isArray(raw) && raw.length > 1) throw new InvalidQuery('afterCursor may be given once.');
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RepositoryEventWaitError('CURSOR_INVALID', 'afterCursor is not a repository event cursor.', 400);
  }
  if (value.length > 512) throw new InvalidQuery('afterCursor is too long.');
  return value;
}

/** Comma-separated or repeated values, deduplicated. */
function list(query: Record<string, unknown>, name: string): string[] | undefined {
  const raw = query[name];
  const values = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .flatMap(value => (typeof value === 'string' ? value.split(',') : [String(value)]))
    .map(value => value.trim()).filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

function positiveInteger(value: string | undefined, name: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new InvalidQuery(`${name} must be an integer from 1 to ${max}.`);
  }
  return parsed;
}

function parseQuery(query: Record<string, unknown>, wait: boolean): ParsedQuery {
  const repositoryValue = single(query, 'repository');
  const validation = validateRepository(repositoryValue);
  if (!validation.valid || !REPOSITORY_PATTERN.test(String(repositoryValue).trim())) {
    throw new InvalidQuery(validation.error ?? 'repository must be owner/repo.');
  }
  const domains = list(query, 'domains');
  if (domains?.some(domain => !isRepositoryEventDomain(domain))) {
    throw new InvalidQuery(`domains must be among: ${REPOSITORY_EVENT_DOMAINS.join(', ')}.`);
  }
  const types = list(query, 'types');
  if (types && (types.length > REPOSITORY_EVENT_MAX_TYPE_FILTERS || types.some(type => !isKnownRepositoryEventType(type)))) {
    throw new InvalidQuery(`types must be at most ${REPOSITORY_EVENT_MAX_TYPE_FILTERS} known event types.`);
  }
  const planId = single(query, 'planId');
  if (planId !== undefined && planId.length > 255) throw new InvalidQuery('planId is too long.');
  const fromStart = single(query, 'fromStart');
  if (fromStart !== undefined && fromStart !== 'true' && fromStart !== 'false') throw new InvalidQuery('fromStart must be true or false.');
  const afterCursor = cursor(query);
  let timeoutSeconds = 0;
  if (wait) {
    const normalized = normalizeRepositoryEventWaitTimeoutSeconds(single(query, 'timeoutSeconds'));
    if (normalized === null) throw new InvalidQuery(`timeoutSeconds must be a number from 0 to ${REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS}.`);
    timeoutSeconds = normalized;
  }
  return {
    repository: String(repositoryValue).trim(),
    afterCursor,
    fromStart: fromStart === 'true',
    domains: domains as RepositoryEventDomain[] | undefined,
    types,
    pullRequest: positiveInteger(single(query, 'pullRequest'), 'pullRequest'),
    planId,
    limit: positiveInteger(single(query, 'limit'), 'limit', REPOSITORY_EVENT_LIST_MAX_LIMIT) ?? REPOSITORY_EVENT_LIST_DEFAULT_LIMIT,
    timeoutSeconds,
  };
}

const defaultConfiguredRepositories = async () =>
  (await loadMonitoredReposRaw()).filter(repo => repo.enabled).map(repo => repo.name);

const defaultVerifyAccess = async (req: Request, repository: string) =>
  verifyGitHubRepositoryAccess(repository, await resolveGitHubMetadataToken(req));

function notAccessible(res: Response): void {
  res.status(404).json({ code: 'REPOSITORY_NOT_ACCESSIBLE', message: 'Repository not found or not accessible', error: 'Repository not found or not accessible' });
}

/** Whether the client connection behind a response is already gone. */
function connectionClosed(req: Request, res: Response): boolean {
  if (res.writableEnded) return false;
  return Boolean(res.destroyed || (res as { closed?: boolean }).closed || req.destroyed || req.socket?.destroyed);
}

export function createRepositoryEventRoutes(deps: RepositoryEventRoutesDeps) {
  const configuredRepositories = deps.configuredRepositories ?? defaultConfiguredRepositories;
  const verifyAccess = deps.verifyAccess ?? defaultVerifyAccess;

  /**
   * Validate the query, then resolve the configured spelling of the
   * repository and prove the caller can read it on GitHub (the check
   * `list_pull_requests` applies). Answers and returns null on failure.
   */
  async function authorize(req: Request, res: Response, wait: boolean): Promise<ParsedQuery | null> {
    if (!req.user?.id) { res.status(401).json({ code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required', error: 'Authentication required' }); return null; }
    let parsed: ParsedQuery;
    try { parsed = parseQuery(req.query ?? {}, wait); }
    catch (error) {
      if (sendJournalError(res, error)) return null;
      if (!(error instanceof InvalidQuery)) throw error;
      res.status(400).json({ code: 'INVALID_INPUT', message: error.message });
      return null;
    }
    const configured = (await configuredRepositories()).find(name => name.toLowerCase() === parsed.repository.toLowerCase());
    if (!configured) { notAccessible(res); return null; }
    try { await verifyAccess(req, configured); }
    catch (error) {
      if (await handleGitHubRepositoryAccessError(req, res, error)) return null;
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === 'number' && status >= 500) {
        res.status(502).json({ code: 'GITHUB_UNAVAILABLE', message: 'GitHub could not be reached to check repository access.', hint: 'Retry; the read has no side effects.' });
        return null;
      }
      throw error;
    }
    return { ...parsed, repository: configured };
  }

  function sendJournalError(res: Response, error: unknown): boolean {
    if (!(error instanceof RepositoryEventWaitError)) return false;
    res.status(error.status).json({ code: error.code, message: error.message, hint: error.recovery });
    return true;
  }

  async function listEvents(req: Request, res: Response): Promise<void> {
    const parsed = await authorize(req, res, false);
    if (!parsed) return;
    try {
      res.json(await (deps.listEvents ?? listRepositoryEventsAfterCursor)({ db: deps.db, ...parsed }));
    } catch (error) {
      if (!sendJournalError(res, error)) throw error;
    }
  }

  /**
   * Bounded wait; a timeout is an ordinary 200 result, and a client disconnect
   * only releases the waiter. Disconnects are tracked before authorization is
   * awaited, and a connection already gone by then never opens a waiter.
   */
  async function waitEvents(req: Request, res: Response): Promise<void> {
    const disconnected = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnected.abort(); };
    res.once?.('close', onClose);
    try {
      const parsed = await authorize(req, res, true);
      if (!parsed) return;
      // A close emitted before the listener was attached is not replayed.
      if (connectionClosed(req, res)) disconnected.abort();
      if (disconnected.signal.aborted) return;
      res.json(await (deps.waitForEvents ?? waitForRepositoryEvents)({
        db: deps.db, ...parsed, ownerId: String(req.user!.id), signal: disconnected.signal,
      }));
    } catch (error) {
      if (error instanceof RepositoryEventWaitError && error.code === 'WAIT_ABORTED') return;
      if (!sendJournalError(res, error)) throw error;
    } finally {
      res.off?.('close', onClose);
    }
  }

  return { listEvents, waitEvents };
}
