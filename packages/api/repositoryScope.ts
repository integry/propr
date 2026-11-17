/**
 * The one place a `repository` query or body filter is resolved against the
 * instance configuration.
 *
 * A filter names a repository case-insensitively; it resolves to the
 * canonical configured spelling, which every route uses for its queries and
 * echoes in its response. Stored names are never rewritten. A repository the
 * instance does not configure, or one the caller cannot read on GitHub, is
 * answered with 404 `REPOSITORY_NOT_ACCESSIBLE`, so a member can neither probe
 * nor spend the instance's GitHub quota on arbitrary repositories. The value
 * `all` keeps meaning every repository where a route allows it.
 */
import type { Request, Response } from 'express';
import { isDemoMode } from './demoMode.js';
import { validateRepository } from './routes/validation.js';

// The instance configuration and GitHub credentials are loaded on first use, so
// a route module (and every suite that builds one with an injected resolver)
// does not open the core database connection just by importing this file.
const githubMetadataAuth = () => import('./githubMetadataAuth.js');

export const ALL_REPOSITORIES = 'all';

export interface ConfiguredRepository { name: string; enabled: boolean }

export interface RepositoryScopeOptions {
  /** Whether `all` (or an absent value) is accepted; it resolves to `all`. Defaults to true. */
  allowAll?: boolean;
  /** Only enabled configured repositories resolve. Defaults to false: a disabled repository keeps its history readable. */
  enabledOnly?: boolean;
}

export interface RepositoryScopeDeps {
  configuredRepositories?: () => Promise<ConfiguredRepository[]>;
  /** Proves the caller can read the repository on GitHub; throws a GitHub-status error otherwise. */
  verifyAccess?: (req: Request, repository: string) => Promise<void>;
  /** Whether the caller's GitHub access is checked; off in demo mode, which has no GitHub identity. */
  checksGitHubAccess?: () => boolean;
  /** How long a proven (user, repository) read access is reused, in milliseconds. */
  accessCacheTtlMs?: number;
  now?: () => number;
}

/**
 * Resolves a filter value to `all` or a canonical configured repository name.
 * Throws {@link RepositoryScopeInputError} for a malformed value,
 * {@link RepositoryNotAccessibleError} for an unknown or unreadable
 * repository, and passes GitHub authorization failures through.
 */
export type RepositoryScopeResolver = (req: Request, value: unknown, options?: RepositoryScopeOptions) => Promise<string>;

export class RepositoryScopeInputError extends Error {
  readonly status = 400;
  readonly code = 'INVALID_INPUT';
}

export class RepositoryNotAccessibleError extends Error {
  readonly status = 404;
  readonly code = 'REPOSITORY_NOT_ACCESSIBLE';
  constructor() { super('Repository not found or not accessible'); }
}

/** Configured spelling of `repository`, matched case-insensitively. */
export function findConfiguredRepository(
  configured: readonly ConfiguredRepository[],
  repository: string,
  enabledOnly = false,
): string | undefined {
  const wanted = repository.trim().toLowerCase();
  const matches = configured.filter(entry => typeof entry.name === 'string' && entry.name.trim().toLowerCase() === wanted);
  const entry = matches.find(candidate => candidate.enabled) ?? (enabledOnly ? undefined : matches[0]);
  return entry?.name.trim();
}

const ACCESS_CACHE_MAX_ENTRIES = 2000;
const DEFAULT_ACCESS_CACHE_TTL_MS = 60_000;

const defaultConfiguredRepositories = async (): Promise<ConfiguredRepository[]> =>
  (await (await import('@propr/core')).loadMonitoredReposRaw()).map(repo => ({ name: repo.name, enabled: repo.enabled }));

const defaultVerifyAccess = async (req: Request, repository: string) => {
  const { resolveGitHubMetadataToken, verifyGitHubRepositoryAccess } = await githubMetadataAuth();
  await verifyGitHubRepositoryAccess(repository, await resolveGitHubMetadataToken(req));
};

/**
 * The filter as sent. Repeated or nested query parameters are not a string,
 * and treating them as absent would widen a read to every repository.
 */
export function singleRepositoryValue(value: unknown): unknown {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new RepositoryScopeInputError('Repository must be a string');
  return value;
}

export function createRepositoryScopeResolver(deps: RepositoryScopeDeps = {}): RepositoryScopeResolver {
  const configuredRepositories = deps.configuredRepositories ?? defaultConfiguredRepositories;
  const verifyAccess = deps.verifyAccess ?? defaultVerifyAccess;
  const checksGitHubAccess = deps.checksGitHubAccess ?? (() => !isDemoMode());
  const ttl = deps.accessCacheTtlMs ?? DEFAULT_ACCESS_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  // Only proven access is remembered, so a revoked grant is noticed within the TTL.
  const proven = new Map<string, number>();

  async function proveAccess(req: Request, repository: string): Promise<void> {
    const userId = req.user?.id;
    // Without an identity there is nothing to remember the proof under.
    if (userId === undefined || userId === null || userId === '' || ttl <= 0) return verifyAccess(req, repository);
    const key = `${userId}\u0000${repository.toLowerCase()}`;
    const until = proven.get(key);
    if (until !== undefined && until > now()) return;
    proven.delete(key);
    await verifyAccess(req, repository);
    if (proven.size >= ACCESS_CACHE_MAX_ENTRIES) proven.delete(proven.keys().next().value as string);
    proven.set(key, now() + ttl);
  }

  return async (req, value, options = {}) => {
    const raw = singleRepositoryValue(value);
    const allowAll = options.allowAll ?? true;
    if (raw === undefined || raw === null || raw === '' || raw === ALL_REPOSITORIES) {
      if (allowAll) return ALL_REPOSITORIES;
      throw new RepositoryScopeInputError('Repository is required');
    }
    const validation = validateRepository(raw);
    if (!validation.valid) throw new RepositoryScopeInputError(validation.error ?? 'Repository must be in format owner/repo');
    const canonical = findConfiguredRepository(await configuredRepositories(), String(raw), options.enabledOnly);
    if (!canonical) throw new RepositoryNotAccessibleError();
    if (checksGitHubAccess()) await proveAccess(req, canonical);
    return canonical;
  };
}

/** The instance resolver: configured repositories and the caller's GitHub read access. */
export const resolveRepositoryScope: RepositoryScopeResolver = createRepositoryScopeResolver();

/** How a route shapes its errors: the `ErrorEnvelope`, or the legacy shape that also carries `error`. */
export type RepositoryScopeErrorShape = 'envelope' | 'legacy';

interface ScopeFailure { status: number; code: string; message: string; hint?: string }

function sendFailure(res: Response, shape: RepositoryScopeErrorShape, { status, code, message, hint }: ScopeFailure): void {
  res.status(status).json({ code, message, ...(shape === 'legacy' ? { error: message } : {}), ...(hint ? { hint } : {}) });
}

/**
 * Answer a scope failure with a stable `code` and `message` (plus the legacy
 * `error` unless the route uses the `ErrorEnvelope`). Returns false for an
 * error that is not a scope failure.
 */
export async function sendRepositoryScopeError(
  req: Request, res: Response, error: unknown, shape: RepositoryScopeErrorShape = 'legacy',
): Promise<boolean> {
  if (error instanceof RepositoryScopeInputError || error instanceof RepositoryNotAccessibleError) {
    sendFailure(res, shape, error);
    return true;
  }
  const status = (error as { status?: unknown } | null)?.status;
  // GitHub hides private repositories from non-members with 404, and answers 403 for some denials.
  if (status === 403 || status === 404) {
    sendFailure(res, shape, new RepositoryNotAccessibleError());
    return true;
  }
  if (await (await githubMetadataAuth()).handleGitHubRepositoryAccessError(req, res, error)) return true;
  if (typeof status === 'number' && status >= 500) {
    sendFailure(res, shape, {
      status: 502, code: 'GITHUB_UNAVAILABLE', message: 'GitHub could not be reached to check repository access.', hint: 'Retry; the read has no side effects.',
    });
    return true;
  }
  return false;
}

/**
 * Resolve the scope or answer the failure. Returns null when the response was
 * sent; an unexpected error is answered 500 and logged under `context`.
 */
export interface RepositoryScopeRespondOptions extends RepositoryScopeOptions {
  /** The route's resolver; the instance resolver unless a test injects one. */
  resolver?: RepositoryScopeResolver;
  /** The route named in the log of an unexpected failure. */
  context?: string;
  errorShape?: RepositoryScopeErrorShape;
  /** The `code` of an unexpected failure; `INTERNAL_ERROR` by default. */
  internalErrorCode?: string;
}

export async function repositoryScopeOrRespond(
  req: Request,
  res: Response,
  value: unknown,
  options: RepositoryScopeRespondOptions = {},
): Promise<string | null> {
  const shape = options.errorShape ?? 'legacy';
  try {
    return await (options.resolver ?? resolveRepositoryScope)(req, value, options);
  } catch (error) {
    if (await sendRepositoryScopeError(req, res, error, shape)) return null;
    console.error(`Error resolving the repository of ${options.context ?? req.path}:`, error);
    sendFailure(res, shape, { status: 500, code: options.internalErrorCode ?? 'INTERNAL_ERROR', message: 'Failed to check repository access.' });
    return null;
  }
}
