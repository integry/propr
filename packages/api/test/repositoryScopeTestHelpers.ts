import {
  ALL_REPOSITORIES,
  RepositoryScopeInputError,
  singleRepositoryValue,
  type RepositoryScopeResolver,
} from '../repositoryScope.js';
import { validateRepository } from '../routes/validation.js';

/**
 * A resolver that trusts every well-formed name as canonical, for suites of
 * routes whose subject is not repository scoping (see repositoryScope.test.ts).
 */
export const unscopedRepositoryResolver: RepositoryScopeResolver = async (_req, value, options = {}) => {
  const raw = singleRepositoryValue(value);
  if (raw === undefined || raw === null || raw === '' || raw === ALL_REPOSITORIES) {
    if (options.allowAll ?? true) return ALL_REPOSITORIES;
    throw new RepositoryScopeInputError('Repository is required');
  }
  const validation = validateRepository(raw);
  if (!validation.valid) throw new RepositoryScopeInputError(validation.error ?? 'Repository must be in format owner/repo');
  return String(raw).trim();
};
