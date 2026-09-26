import { normalizeGitHubAttachmentPlanOverride } from '@propr/shared';
import type { MonitoredRepo } from '../api/proprApi';

export type VisualPreviewSettings = NonNullable<MonitoredRepo['visualPreview']>;

export type ManagedRepo = Omit<MonitoredRepo, 'autoFollowupOnFailedCi' | 'cancelCiDuringFollowup' | 'cancelCiDuringFollowupWorkflows' | 'visualPreview'> & {
  autoFollowupOnFailedCi: boolean;
  cancelCiDuringFollowup: boolean;
  cancelCiDuringFollowupWorkflows: string[];
  visualPreview: VisualPreviewSettings;
};

export const getRepositoryConfigKey = (name: string): string => name.trim().toLowerCase();

export const defaultVisualPreview = (): VisualPreviewSettings => ({ enabled: false, types: ['image'] });

/** Stored selections are exact workflow identities: trimmed, de-duplicated, never empty strings. */
export function parseWorkflowSelection(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const selection: string[] = [];
  for (const entry of value) {
    const workflow = typeof entry === 'string' ? entry.trim() : '';
    if (workflow && !selection.some(existing => existing.toLowerCase() === workflow.toLowerCase())) selection.push(workflow);
  }
  return selection;
}

export function parseVisualPreview(value: unknown): VisualPreviewSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultVisualPreview();
  const candidate = value as Record<string, unknown>;
  const types = Array.isArray(candidate.types)
    ? [...new Set(candidate.types.filter((type): type is 'image' | 'video' => type === 'image' || type === 'video'))]
    : [];
  const instructions = typeof candidate.instructions === 'string' && candidate.instructions.trim()
    ? candidate.instructions.trim()
    : undefined;
  return {
    enabled: candidate.enabled === true,
    ...(candidate.githubAttachmentPlan !== undefined ? { githubAttachmentPlan: normalizeGitHubAttachmentPlanOverride(candidate.githubAttachmentPlan) } : {}),
    ...(candidate.githubAttachmentCapacity ? { githubAttachmentCapacity: candidate.githubAttachmentCapacity as VisualPreviewSettings['githubAttachmentCapacity'] } : {}),
    types: types.length > 0 ? types : ['image'],
    ...(instructions ? { instructions } : {})
  };
}

export function updateRepositoryVisualPreview(
  repos: ManagedRepo[],
  repoId: string,
  settings: VisualPreviewSettings
): ManagedRepo[] {
  const targetRepo = repos.find(repo => repo.id === repoId);
  if (!targetRepo) return repos;
  const repositoryKey = getRepositoryConfigKey(targetRepo.name);
  const normalizedSettings = parseVisualPreview(settings);
  return repos.map(repo => getRepositoryConfigKey(repo.name) === repositoryKey
    ? { ...repo, visualPreview: normalizedSettings }
    : repo);
}

/**
 * Resolve the repository-wide notification state from all of its branch entries.
 * Kept identical to the server filter: notifications are disabled only when every
 * entry is explicitly false, so legacy or partially configured entries stay on.
 */
export function resolveRepositoryNotificationsEnabled(
  repos: readonly ManagedRepo[],
  repositoryKey: string
): boolean {
  const entries = repos.filter(repo => getRepositoryConfigKey(repo.name) === repositoryKey);
  return entries.length === 0 || entries.some(repo => repo.notificationsEnabled !== false);
}

/** Flip the resolved repository-wide value so every branch entry converges on one state. */
export function toggleRepositoryNotifications(repos: ManagedRepo[], repoId: string): ManagedRepo[] {
  const targetRepo = repos.find(repo => repo.id === repoId);
  if (!targetRepo) return repos;
  const repositoryKey = getRepositoryConfigKey(targetRepo.name);
  const notificationsEnabled = !resolveRepositoryNotificationsEnabled(repos, repositoryKey);
  return repos.map(repo => getRepositoryConfigKey(repo.name) === repositoryKey
    ? { ...repo, notificationsEnabled }
    : repo);
}

/** Every branch entry of a repository shares one workflow selection, like the option it belongs to. */
export function updateRepositoryCancelCiWorkflows(repos: ManagedRepo[], repoId: string, workflows: string[]): ManagedRepo[] {
  const targetRepo = repos.find(repo => repo.id === repoId);
  if (!targetRepo) return repos;
  const repositoryKey = getRepositoryConfigKey(targetRepo.name);
  const selection = parseWorkflowSelection(workflows);
  return repos.map(repo => getRepositoryConfigKey(repo.name) === repositoryKey
    ? { ...repo, cancelCiDuringFollowupWorkflows: selection }
    : repo);
}

/** Flip the resolved repository-wide value so every branch entry converges on one state. */
export function toggleRepositoryCancelCiDuringFollowup(repos: ManagedRepo[], repoId: string): ManagedRepo[] {
  const targetRepo = repos.find(repo => repo.id === repoId);
  if (!targetRepo) return repos;
  const repositoryKey = getRepositoryConfigKey(targetRepo.name);
  const cancelCiDuringFollowup = !repos.some(repo =>
    getRepositoryConfigKey(repo.name) === repositoryKey && repo.cancelCiDuringFollowup
  );
  return repos.map(repo => getRepositoryConfigKey(repo.name) === repositoryKey
    ? { ...repo, cancelCiDuringFollowup }
    : repo);
}

export function buildRepositoriesForDisplay(repos: ManagedRepo[]): ManagedRepo[] {
  const autoCiFollowupByRepository = new Map<string, boolean>();
  const cancelCiByRepository = new Map<string, boolean>();
  const cancelCiWorkflowsByRepository = new Map<string, string[]>();
  const visualPreviewByRepository = new Map<string, VisualPreviewSettings>();
  for (const repo of repos) {
    const key = getRepositoryConfigKey(repo.name);
    autoCiFollowupByRepository.set(key, autoCiFollowupByRepository.get(key) === true || repo.autoFollowupOnFailedCi);
    cancelCiByRepository.set(key, cancelCiByRepository.get(key) === true || repo.cancelCiDuringFollowup);
    // The worker cancels the union of every branch entry's selection, so the
    // display has to show exactly that union: a selection stored on one entry
    // only would otherwise hide a workflow the repository may cancel.
    cancelCiWorkflowsByRepository.set(key, parseWorkflowSelection([
      ...(cancelCiWorkflowsByRepository.get(key) ?? []),
      ...(Array.isArray(repo.cancelCiDuringFollowupWorkflows) ? repo.cancelCiDuringFollowupWorkflows : [])
    ]));
    const previousPreview = visualPreviewByRepository.get(key);
    if (!previousPreview || (!previousPreview.enabled && repo.visualPreview.enabled)) {
      visualPreviewByRepository.set(key, repo.visualPreview);
    }
  }

  return repos.map(repo => ({
    ...repo,
    autoFollowupOnFailedCi: autoCiFollowupByRepository.get(getRepositoryConfigKey(repo.name)) === true,
    cancelCiDuringFollowup: cancelCiByRepository.get(getRepositoryConfigKey(repo.name)) === true,
    cancelCiDuringFollowupWorkflows: cancelCiWorkflowsByRepository.get(getRepositoryConfigKey(repo.name)) ?? [],
    notificationsEnabled: resolveRepositoryNotificationsEnabled(repos, getRepositoryConfigKey(repo.name)),
    visualPreview: visualPreviewByRepository.get(getRepositoryConfigKey(repo.name)) || defaultVisualPreview()
  }));
}
