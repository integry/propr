import { randomUUID } from 'crypto';
import type { RepoToMonitor, VisualPreviewSettings, VisualPreviewType } from '@propr/core';
import { normalizeOptionalBranchName } from './branchNameValidation.js';

const MAX_VISUAL_PREVIEW_INSTRUCTIONS_LENGTH = 4000;

function normalizeStoredVisualPreviewSettings(value: unknown): VisualPreviewSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { enabled: false, types: ['image'] };
  }
  const candidate = value as Partial<VisualPreviewSettings>;
  const types = Array.isArray(candidate.types)
    ? [...new Set(candidate.types.filter((type): type is VisualPreviewType => type === 'image' || type === 'video'))]
    : [];
  const instructions = typeof candidate.instructions === 'string' && candidate.instructions.trim()
    ? candidate.instructions.trim()
    : undefined;
  return {
    enabled: candidate.enabled === true,
    types: types.length > 0 ? types : ['image'],
    ...(instructions ? { instructions } : {})
  };
}

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
    !isValidRepoName(name) ||
    typeof enabled !== 'boolean'
  ) {
    return failure('Invalid repository format: name must be owner/repo and enabled must be a boolean');
  }
  return success({ name, enabled });
}

export function isValidRepoName(value: string): boolean {
  return /^[a-zA-Z0-9\-_]+\/[a-zA-Z0-9\-_.]+$/.test(value);
}

export function withDefaultRepoAutoFollowup(repo: RepoToMonitor): RepoToMonitor {
  return { ...repo, autoFollowupOnFailedCi: repo.autoFollowupOnFailedCi === true };
}

export function withDefaultRepoOptions(repo: RepoToMonitor): RepoToMonitor {
  return {
    ...withDefaultRepoAutoFollowup(repo),
    visualPreview: normalizeStoredVisualPreviewSettings(repo.visualPreview)
  };
}

export function preserveRepoAutoFollowup(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  return normalizedRepos.map((repo, index) => {
    const incomingRepo = incomingRepos[index] as Partial<RepoToMonitor>;
    if (incomingRepo.autoFollowupOnFailedCi !== undefined) return repo;
    const previousRepo = previousRepos.find(candidate => candidate.id === repo.id);
    return { ...repo, autoFollowupOnFailedCi: previousRepo?.autoFollowupOnFailedCi === true };
  });
}

export function preserveRepoVisualPreview(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  const explicitByRepository = new Map<string, VisualPreviewSettings>();
  normalizedRepos.forEach((repo, index) => {
    const incoming = incomingRepos[index] as Partial<RepoToMonitor>;
    if (incoming.visualPreview !== undefined) {
      explicitByRepository.set(repo.name.trim().toLowerCase(), normalizeStoredVisualPreviewSettings(repo.visualPreview));
    }
  });

  return normalizedRepos.map(repo => {
    const repositoryKey = repo.name.trim().toLowerCase();
    const explicit = explicitByRepository.get(repositoryKey);
    if (explicit) return { ...repo, visualPreview: explicit };

    const previous = previousRepos.find(candidate => candidate.name.trim().toLowerCase() === repositoryKey);
    return { ...repo, visualPreview: normalizeStoredVisualPreviewSettings(previous?.visualPreview) };
  });
}

function normalizeVisualPreviewTypes(value: unknown, repoName: string): ValidationResult<VisualPreviewType[]> {
  if (!Array.isArray(value)) {
    return failure(`Invalid visualPreview.types format for ${repoName}: must be an array`);
  }
  if (value.some(type => type !== 'image' && type !== 'video')) {
    return failure(`Invalid visualPreview.types format for ${repoName}: supported values are image and video`);
  }
  return success([...new Set(value as VisualPreviewType[])]);
}

function normalizeVisualPreview(value: unknown, repoName: string): ValidationResult<VisualPreviewSettings> {
  if (value === undefined) return success({ enabled: false, types: ['image'] });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure(`Invalid visualPreview format for ${repoName}: must be an object`);
  }

  const candidate = value as Partial<VisualPreviewSettings>;
  if (typeof candidate.enabled !== 'boolean') {
    return failure(`Invalid visualPreview.enabled format for ${repoName}: must be a boolean`);
  }
  const types = normalizeVisualPreviewTypes(candidate.types, repoName);
  if (!types.ok) return types;
  if (candidate.enabled && types.value.length === 0) {
    return failure(`Invalid visualPreview.types format for ${repoName}: select at least one type when previews are enabled`);
  }
  if (candidate.instructions !== undefined && typeof candidate.instructions !== 'string') {
    return failure(`Invalid visualPreview.instructions format for ${repoName}: must be a string`);
  }
  const instructions = candidate.instructions?.trim();
  if (instructions && instructions.length > MAX_VISUAL_PREVIEW_INSTRUCTIONS_LENGTH) {
    return failure(`Invalid visualPreview.instructions format for ${repoName}: must be ${MAX_VISUAL_PREVIEW_INSTRUCTIONS_LENGTH} characters or fewer`);
  }

  return success({
    enabled: candidate.enabled,
    types: types.value.length > 0 ? types.value : ['image'],
    ...(instructions ? { instructions } : {})
  });
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
  if (candidate.autoFollowupOnFailedCi !== undefined && typeof candidate.autoFollowupOnFailedCi !== 'boolean') {
    return failure(`Invalid autoFollowupOnFailedCi format for ${name}: must be a boolean`);
  }
  const visualPreview = normalizeVisualPreview(candidate.visualPreview, name);
  if (!visualPreview.ok) return visualPreview;

  return success({
    id: candidate.id?.trim() || randomUUID(),
    name,
    enabled,
    autoFollowupOnFailedCi: candidate.autoFollowupOnFailedCi ?? false,
    visualPreview: visualPreview.value,
    alias: alias.value,
    baseBranch: baseBranch.value,
    defaultBranch: defaultBranch.value
  });
}
