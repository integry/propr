import type { RepoToMonitor } from '@propr/core';
import { assertGitHubRepositoryIdentity } from '../../core/src/git/repositoryPaths.js';

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isValidContextRepositoryName(value: string): boolean {
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  try {
    assertGitHubRepositoryIdentity(parts[0], parts[1]);
    return true;
  } catch { return false; }
}

export function normalizeContextRepositories(context: RepoToMonitor['contextRepositories']): ValidationResult<RepoToMonitor['contextRepositories']> {
  if (context !== undefined && context !== 'all' && context !== 'none'
      && (!Array.isArray(context) || context.length > 499 || context.some(entry =>
        typeof entry !== 'string' || !isValidContextRepositoryName(entry)))) {
    return { ok: false, error: 'Context repositories must be all, none, or up to 499 owner/repository names' };
  }
  return { ok: true, value: Array.isArray(context) ? [...new Set(context.map(name => name.toLowerCase()))] : context };
}
