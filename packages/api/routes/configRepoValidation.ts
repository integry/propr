import { randomUUID } from 'crypto';
import type { RepoToMonitor } from '@propr/core';
import { normalizeOptionalBranchName } from './branchNameValidation.js';

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function success<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function failure<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function normalizeOptionalString(value: unknown, fieldName: string, repoName: string): ValidationResult<string | undefined> {
  if (value === undefined) return success(undefined);
  if (typeof value !== 'string') return failure(`Invalid ${fieldName} format for ${repoName}: must be a string`);
  return success(value.trim() || undefined);
}

function parseRepoObject(repo: unknown): ValidationResult<Partial<RepoToMonitor>> {
  if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
    return failure('Invalid repository format: name must be owner/repo and enabled must be a boolean');
  }
  return success(repo as Partial<RepoToMonitor>);
}

function validateRepoIdentity(candidate: Partial<RepoToMonitor>): ValidationResult<{ name: string; enabled: boolean }> {
  const { name, enabled } = candidate;
  if (
    typeof name !== 'string' ||
    !name.match(/^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/) ||
    typeof enabled !== 'boolean'
  ) {
    return failure('Invalid repository format: name must be owner/repo and enabled must be a boolean');
  }
  return success({ name, enabled });
}

export function normalizeRepoConfig(repo: unknown): ValidationResult<RepoToMonitor> {
  const candidateResult = parseRepoObject(repo);
  if (!candidateResult.ok) return candidateResult;
  const candidate = candidateResult.value;
  const identity = validateRepoIdentity(candidate);
  if (!identity.ok) return identity;
  const { name, enabled } = identity.value;

  if (candidate.id !== undefined && (typeof candidate.id !== 'string' || !candidate.id.trim())) {
    return failure(`Invalid id format for ${name}: must be a non-empty string`);
  }
  const alias = normalizeOptionalString(candidate.alias, 'alias', name);
  if (!alias.ok) return alias;
  const baseBranch = normalizeOptionalBranchName(candidate.baseBranch, 'baseBranch', name);
  if (!baseBranch.ok) return baseBranch;
  const defaultBranch = normalizeOptionalBranchName(candidate.defaultBranch, 'defaultBranch', name);
  if (!defaultBranch.ok) return defaultBranch;
  if (candidate.demoVisible !== undefined && typeof candidate.demoVisible !== 'boolean') {
    return failure(`Invalid demoVisible format for ${name}: must be a boolean`);
  }

  return success({
    id: candidate.id?.trim() || randomUUID(),
    name,
    enabled,
    alias: alias.value,
    baseBranch: baseBranch.value,
    defaultBranch: defaultBranch.value,
    demoVisible: candidate.demoVisible
  });
}
