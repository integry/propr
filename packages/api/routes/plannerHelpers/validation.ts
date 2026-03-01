/**
 * Input validation utilities.
 */

import type { ContextRepositoryInput } from './types.js';

export const VALID_GRANULARITIES = ['single', 'balanced', 'granular'] as const;
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9._/-]+$/;

export function validateContextRepositories(
  repos: unknown
): { valid: boolean; error?: string; repositories?: ContextRepositoryInput[] } {
  if (!repos) {
    return { valid: true, repositories: [] };
  }

  if (!Array.isArray(repos)) {
    return { valid: false, error: 'contextRepositories must be an array' };
  }

  const validated: ContextRepositoryInput[] = [];

  for (const repo of repos) {
    if (!repo || typeof repo !== 'object') {
      return { valid: false, error: 'Each context repository must be an object' };
    }

    if (!repo.repository || typeof repo.repository !== 'string') {
      return { valid: false, error: 'Each context repository must have a repository field' };
    }

    // Validate repository format (owner/repo)
    if (!repo.repository.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/)) {
      return { valid: false, error: `Invalid repository format: ${repo.repository}` };
    }

    validated.push({
      repository: repo.repository,
      branch: typeof repo.branch === 'string' ? repo.branch : undefined,
      description: typeof repo.description === 'string' ? repo.description : undefined
    });
  }

  return { valid: true, repositories: validated };
}

export function validatePreviewInput(body: Record<string, unknown>): { valid: boolean; error?: string } {
  const { draftId, prompt, baseBranch, granularity, files, contextRepositories } = body;
  if (!draftId) return { valid: false, error: 'draftId is required' };
  if (!prompt || typeof prompt !== 'string') return { valid: false, error: 'prompt is required' };
  if (!baseBranch || typeof baseBranch !== 'string') return { valid: false, error: 'baseBranch is required' };
  if (!BRANCH_NAME_REGEX.test(baseBranch as string)) return { valid: false, error: 'Invalid branch name format' };
  if (granularity && !VALID_GRANULARITIES.includes(granularity as typeof VALID_GRANULARITIES[number])) return { valid: false, error: `granularity must be one of: ${VALID_GRANULARITIES.join(', ')}` };
  if (files && (!Array.isArray(files) || !files.every(f => typeof f === 'string'))) return { valid: false, error: 'files must be an array of strings' };

  // Validate context repositories if provided
  if (contextRepositories !== undefined) {
    const repoValidation = validateContextRepositories(contextRepositories);
    if (!repoValidation.valid) {
      return { valid: false, error: repoValidation.error };
    }
  }

  return { valid: true };
}
