import { normalizeGitHubAttachmentPlanOverride } from '@propr/shared';
import { randomUUID } from 'crypto';
import type { RepoToMonitor, VisualPreviewSettings, VisualPreviewType } from '@propr/core';
import { normalizeOptionalBranchName } from './branchNameValidation.js';

const MAX_VISUAL_PREVIEW_INSTRUCTIONS_LENGTH = 4000;

// Keep API input normalization side-effect-free. Importing the core package at
// runtime initializes GitHub authentication, while this validator is also used
// by standalone tooling and unit tests.
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
    ...(candidate.githubAttachmentPlan !== undefined ? { githubAttachmentPlan: normalizeGitHubAttachmentPlanOverride(candidate.githubAttachmentPlan) } : {}),
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
    cancelCiDuringFollowup: repo.cancelCiDuringFollowup === true,
    cancelCiDuringFollowupWorkflows: normalizeStoredWorkflowSelection(repo.cancelCiDuringFollowupWorkflows),
    notificationsEnabled: repo.notificationsEnabled !== false,
    visualPreview: normalizeStoredVisualPreviewSettings(repo.visualPreview)
  };
}

export function preserveRepoAutoFollowup(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  return preserveRepoBooleanOption(previousRepos, normalizedRepos, incomingRepos, 'autoFollowupOnFailedCi');
}

/**
 * Clients that do not know the option (older UIs, the CLI, scripts) submit
 * repositories without it; their writes must never silently switch it off.
 */
export function preserveRepoCancelCiDuringFollowup(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  return preserveRepoBooleanOption(previousRepos, normalizedRepos, incomingRepos, 'cancelCiDuringFollowup');
}

/**
 * The selected workflows are the permission to cancel them, so a client that
 * does not know the field must never drop the operator's selection either.
 */
export function preserveRepoCancelCiWorkflows(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  return normalizedRepos.map((repo, index) => {
    const incomingRepo = incomingRepos[index] as Partial<RepoToMonitor>;
    if (incomingRepo.cancelCiDuringFollowupWorkflows !== undefined) return repo;
    const previousRepo = previousRepos.find(candidate => candidate.id === repo.id);
    return { ...repo, cancelCiDuringFollowupWorkflows: normalizeStoredWorkflowSelection(previousRepo?.cancelCiDuringFollowupWorkflows) };
  });
}

/** Keeps a stored selection usable regardless of how it was written: trimmed, de-duplicated, empty entries dropped. */
export function normalizeStoredWorkflowSelection(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const selection: string[] = [];
  for (const entry of value) {
    const workflow = typeof entry === 'string' ? entry.trim() : '';
    if (workflow && !selection.some(existing => existing.toLowerCase() === workflow.toLowerCase())) selection.push(workflow);
  }
  return selection;
}

function preserveRepoBooleanOption(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[],
  option: 'autoFollowupOnFailedCi' | 'cancelCiDuringFollowup'
): RepoToMonitor[] {
  return normalizedRepos.map((repo, index) => {
    const incomingRepo = incomingRepos[index] as Partial<RepoToMonitor>;
    if (incomingRepo[option] !== undefined) return repo;
    const previousRepo = previousRepos.find(candidate => candidate.id === repo.id);
    return { ...repo, [option]: previousRepo?.[option] === true };
  });
}

function repositoryKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve the repository-wide notification state from all stored entries of a
 * repository. Notifications are disabled only when every entry is explicitly
 * false; a missing field or any `true` entry keeps them enabled (fail open).
 * Mirrored by the notification projection filter and the Web UI.
 */
export function resolveStoredRepoNotificationsEnabled(entries: readonly RepoToMonitor[]): boolean {
  return entries.length === 0 || entries.some(entry => entry.notificationsEnabled !== false);
}

/**
 * Notifications are a repository-wide setting shared by every branch entry.
 * An explicit change on any entry is applied to all entries of the same
 * repository; entries submitted without the field (partial or legacy clients)
 * keep the stored repository value instead of silently re-enabling it.
 */
export function preserveRepoNotifications(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  const storedByRepository = new Map<string, boolean>();
  for (const key of new Set(previousRepos.map(repo => repositoryKeyOf(repo.name)))) {
    storedByRepository.set(key, resolveStoredRepoNotificationsEnabled(
      previousRepos.filter(repo => repositoryKeyOf(repo.name) === key)
    ));
  }

  const changedByRepository = new Map<string, boolean>();
  normalizedRepos.forEach((repo, index) => {
    const incoming = incomingRepos[index] as Partial<RepoToMonitor>;
    if (typeof incoming?.notificationsEnabled !== 'boolean') return;
    const repositoryKey = repositoryKeyOf(repo.name);
    if (changedByRepository.has(repositoryKey)) return;
    const previousEntry = previousRepos.find(candidate => candidate.id === repo.id);
    const previousValue = previousEntry
      ? previousEntry.notificationsEnabled !== false
      : storedByRepository.get(repositoryKey);
    if (previousValue !== incoming.notificationsEnabled) {
      changedByRepository.set(repositoryKey, incoming.notificationsEnabled);
    }
  });

  return normalizedRepos.map((repo, index) => {
    const repositoryKey = repositoryKeyOf(repo.name);
    const changed = changedByRepository.get(repositoryKey);
    if (changed !== undefined) return { ...repo, notificationsEnabled: changed };
    const incoming = incomingRepos[index] as Partial<RepoToMonitor>;
    if (typeof incoming?.notificationsEnabled === 'boolean') return repo;
    return { ...repo, notificationsEnabled: storedByRepository.get(repositoryKey) ?? true };
  });
}

function visualPreviewSettingsEqual(left: VisualPreviewSettings, right: VisualPreviewSettings): boolean {
  // GET materializes legacy missing plans as auto; that alone is not an edit.
  return (left.githubAttachmentPlan ?? 'auto') === (right.githubAttachmentPlan ?? 'auto')
    && left.enabled === right.enabled
    && JSON.stringify(left.types) === JSON.stringify(right.types)
    && left.instructions === right.instructions;
}

export function preserveRepoVisualPreview(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  const explicitByRepository = new Map<string, VisualPreviewSettings>();
  const changedByRepository = new Map<string, VisualPreviewSettings>();
  normalizedRepos.forEach((repo, index) => {
    const incoming = incomingRepos[index] as Partial<RepoToMonitor>;
    if (incoming.visualPreview !== undefined) {
      const repositoryKey = repo.name.trim().toLowerCase();
      const normalized = normalizeStoredVisualPreviewSettings(repo.visualPreview);
      if (!explicitByRepository.has(repositoryKey)) explicitByRepository.set(repositoryKey, normalized);
      const previous = previousRepos.find(candidate => candidate.id === repo.id);
      if (!visualPreviewSettingsEqual(normalized, normalizeStoredVisualPreviewSettings(previous?.visualPreview))) {
        changedByRepository.set(repositoryKey, normalized);
      }
    }
  });

  return normalizedRepos.map(repo => {
    const repositoryKey = repo.name.trim().toLowerCase();
    const changed = changedByRepository.get(repositoryKey);
    if (changed) return { ...repo, visualPreview: changed };

    const previousMatches = previousRepos.filter(
      candidate => candidate.name.trim().toLowerCase() === repositoryKey
    );
    if (previousMatches.length > 0) {
      const configured = previousMatches.find(
        candidate => normalizeStoredVisualPreviewSettings(candidate.visualPreview).enabled
      ) ?? previousMatches.find(candidate => candidate.visualPreview !== undefined);
      return { ...repo, visualPreview: normalizeStoredVisualPreviewSettings(configured?.visualPreview) };
    }

    const explicit = explicitByRepository.get(repositoryKey);
    return { ...repo, visualPreview: explicit ?? normalizeStoredVisualPreviewSettings(repo.visualPreview) };
  });
}

function normalizeVisualPreviewTypes(value: unknown, repoName: string): ValidationResult<VisualPreviewType[]> {
  if (value === undefined) return success(['image']);
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
  if (candidate.githubAttachmentPlan !== undefined && !['auto', 'free', 'paid'].includes(candidate.githubAttachmentPlan)) {
    return failure(`Invalid visualPreview.githubAttachmentPlan for ${repoName}: supported values are auto, free, and paid`);
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
    ...(candidate.githubAttachmentPlan !== undefined ? { githubAttachmentPlan: candidate.githubAttachmentPlan } : {}),
    types: types.value.length > 0 ? types.value : ['image'],
    ...(instructions ? { instructions } : {})
  });
}

/** Upper bounds on the stored selection: a workflow identity is a path, a file name, a display name or a numeric ID. */
const MAX_CANCEL_CI_WORKFLOWS = 50;
const MAX_CANCEL_CI_WORKFLOW_LENGTH = 255;

/**
 * The exact workflows follow-up CI cancellation may cancel for a repository.
 * Only explicit, complete identities are accepted — never a pattern — because
 * everything on this list is permission to cancel that workflow's runs.
 */
function normalizeWorkflowSelection(value: unknown, repoName: string): ValidationResult<string[]> {
  if (value === undefined || value === null) return success([]);
  if (!Array.isArray(value)) {
    return failure(`Invalid cancelCiDuringFollowupWorkflows format for ${repoName}: must be an array of workflow names, paths or IDs`);
  }
  if (value.length > MAX_CANCEL_CI_WORKFLOWS) {
    return failure(`Invalid cancelCiDuringFollowupWorkflows format for ${repoName}: at most ${MAX_CANCEL_CI_WORKFLOWS} workflows`);
  }
  const selection: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return failure(`Invalid cancelCiDuringFollowupWorkflows format for ${repoName}: every workflow must be a string`);
    }
    const workflow = entry.trim();
    if (!workflow) continue;
    if (workflow.length > MAX_CANCEL_CI_WORKFLOW_LENGTH) {
      return failure(`Invalid cancelCiDuringFollowupWorkflows format for ${repoName}: a workflow must be ${MAX_CANCEL_CI_WORKFLOW_LENGTH} characters or fewer`);
    }
    if (!selection.some(existing => existing.toLowerCase() === workflow.toLowerCase())) selection.push(workflow);
  }
  return success(selection);
}

/** Optional booleans that are rejected when present with a non-boolean value. */
const OPTIONAL_BOOLEAN_FIELDS = ['autoFollowupOnFailedCi', 'cancelCiDuringFollowup', 'notificationsEnabled'] as const;

function validateOptionalBooleans(candidate: Partial<RepoToMonitor>, repoName: string): ValidationResult<undefined> {
  for (const field of OPTIONAL_BOOLEAN_FIELDS) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'boolean') {
      return failure(`Invalid ${field} format for ${repoName}: must be a boolean`);
    }
  }
  return success(undefined);
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
  const booleans = validateOptionalBooleans(candidate, name);
  if (!booleans.ok) return booleans;
  const cancelCiWorkflows = normalizeWorkflowSelection(candidate.cancelCiDuringFollowupWorkflows, name);
  if (!cancelCiWorkflows.ok) return cancelCiWorkflows;
  const visualPreview = normalizeVisualPreview(candidate.visualPreview, name);
  if (!visualPreview.ok) return visualPreview;

  return success({
    id: candidate.id?.trim() || randomUUID(),
    name,
    enabled,
    autoFollowupOnFailedCi: candidate.autoFollowupOnFailedCi ?? false,
    cancelCiDuringFollowup: candidate.cancelCiDuringFollowup ?? false,
    cancelCiDuringFollowupWorkflows: cancelCiWorkflows.value,
    notificationsEnabled: candidate.notificationsEnabled !== false,
    visualPreview: visualPreview.value,
    alias: alias.value,
    baseBranch: baseBranch.value,
    defaultBranch: defaultBranch.value
  });
}

/**
 * Every per-repository option whose absence from a write must not clear it.
 * Callers apply the whole chain so a new option cannot be forgotten at one
 * call site and silently reset by partial or legacy clients.
 */
export function preserveRepoSettings(
  previousRepos: RepoToMonitor[],
  normalizedRepos: RepoToMonitor[],
  incomingRepos: unknown[]
): RepoToMonitor[] {
  let repos = preserveRepoAutoFollowup(previousRepos, normalizedRepos, incomingRepos);
  repos = preserveRepoCancelCiDuringFollowup(previousRepos, repos, incomingRepos);
  repos = preserveRepoCancelCiWorkflows(previousRepos, repos, incomingRepos);
  repos = preserveRepoNotifications(previousRepos, repos, incomingRepos);
  return preserveRepoVisualPreview(previousRepos, repos, incomingRepos);
}
