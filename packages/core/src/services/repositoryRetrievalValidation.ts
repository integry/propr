/**
 * Input validation helpers for the repository retrieval service.
 */

import { RepositoryRetrievalError, type RepositorySearchPagination } from './repositoryRetrievalTypes.js';

export function parseRepository(repository: string): { owner: string; repoName: string } {
  const match = typeof repository === 'string' ? repository.trim().match(/^([^/\s]+)\/([^/\s]+)$/) : null;
  if (!match) {
    throw new RepositoryRetrievalError('Invalid repository format. Expected "owner/repo"', 400);
  }
  return { owner: match[1], repoName: match[2] };
}

/**
 * Rejects anything that could escape the repository tree or be interpreted
 * as something other than a plain relative path.
 */
export function assertSafeRepositoryPath(value: string, label = 'path'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RepositoryRetrievalError(`${label} is required`, 400);
  }
  if (value.includes('\0')) {
    throw new RepositoryRetrievalError(`${label} must not contain null bytes`, 400);
  }
  if (value.includes('\\')) {
    throw new RepositoryRetrievalError(`${label} must use forward slashes, not backslashes`, 400);
  }
  if (value.startsWith('/')) {
    throw new RepositoryRetrievalError(`${label} must be relative to the repository root`, 400);
  }
  if (value.includes('..')) {
    throw new RepositoryRetrievalError(`${label} must not contain ".."`, 400);
  }
  return value;
}

export function normalizePathPrefix(prefix: string | undefined): string | null {
  if (prefix === undefined || prefix === null) return null;
  let trimmed = prefix.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './') return null;
  assertSafeRepositoryPath(trimmed, 'path prefix');
  if (trimmed.startsWith('./')) trimmed = trimmed.slice(2);
  return trimmed;
}

export function assertSafeRef(ref: string): string {
  if (!ref || ref.startsWith('-') || /[\s\0\\]|\.\.|[~^:?*[]|@\{/.test(ref)) {
    throw new RepositoryRetrievalError(`Invalid ref "${ref}"`, 400);
  }
  return ref;
}

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export function isFullCommitSha(ref: string): boolean {
  return FULL_COMMIT_SHA.test(ref);
}

/** A ref name on origin and the local ref an explicit fetch stores it under. */
export interface RemoteRefMapping {
  remote: string;
  local: string;
}

/**
 * Where a validated ref may live on origin, most specific first, and where it
 * is kept locally once fetched. Qualified refs keep their namespace (so
 * `refs/heads/x` is never looked up as `refs/heads/refs/heads/x`); a short
 * name may be either a branch or a tag, and `origin/x` is remote-tracking
 * shorthand for branch `x` (after a tag of that name, as git resolves it).
 * HEAD and commit SHAs have no mapping.
 */
export function remoteRefMappings(ref: string): RemoteRefMapping[] {
  if (ref === 'HEAD' || isFullCommitSha(ref)) return [];
  const branch = (name: string): RemoteRefMapping => ({ remote: `refs/heads/${name}`, local: `refs/remotes/origin/${name}` });
  if (ref.startsWith('refs/heads/')) return [branch(ref.slice('refs/heads/'.length))];
  if (ref.startsWith('refs/remotes/origin/')) return [branch(ref.slice('refs/remotes/origin/'.length))];
  if (ref.startsWith('refs/')) return [{ remote: ref, local: ref }];
  const tag = { remote: `refs/tags/${ref}`, local: `refs/tags/${ref}` };
  if (ref.startsWith('origin/')) return [tag, branch(ref.slice('origin/'.length))];
  return [branch(ref), tag];
}

export interface IntegerBounds {
  fallback: number;
  min: number;
  max: number;
}

export function boundedInteger(value: number | undefined, label: string, { fallback, min, max }: IntegerBounds): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new RepositoryRetrievalError(`${label} must be an integer >= ${min}`, 400);
  }
  return Math.min(value, max);
}

export function buildPagination(offset: number, limit: number, total: number): RepositorySearchPagination {
  const next = offset + limit;
  return { offset, limit, totalMatches: total, nextOffset: next < total ? next : null };
}
