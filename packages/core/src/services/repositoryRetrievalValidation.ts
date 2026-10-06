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
