import { isGitHubLogin, normalizeGitHubAttachmentPlanOverride } from '@propr/shared';
import type { MonitoredRepo } from '../api/proprApi';

export type VisualPreviewSettings = NonNullable<MonitoredRepo['visualPreview']>;

export type ManagedRepo = Omit<MonitoredRepo, 'autoFollowupOnFailedCi' | 'cancelCiDuringFollowup' | 'cancelCiDuringFollowupWorkflows' | 'nonBlockingChecks' | 'autoAssignPullRequests' | 'autoAssignDefaultAssignee' | 'autoAssignRequestReview' | 'visualPreview'> & {
  autoFollowupOnFailedCi: boolean;
  autoAssignPullRequests: boolean;
  autoAssignDefaultAssignee: string | null;
  autoAssignRequestReview: boolean;
  cancelCiDuringFollowup: boolean;
  cancelCiDuringFollowupWorkflows: string[];
  nonBlockingChecks: string[];
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

/**
 * Repository-wide merge-conflict auto-resolve override, mirroring the server:
 * the first explicit entry wins; `null` means the repository inherits the
 * instance default.
 */
export function resolveRepositoryAutoResolveMergeConflicts(
  repos: readonly ManagedRepo[],
  repositoryKey: string
): boolean | null {
  const explicit = repos.find(repo => getRepositoryConfigKey(repo.name) === repositoryKey && typeof repo.autoResolveMergeConflicts === 'boolean');
  return typeof explicit?.autoResolveMergeConflicts === 'boolean' ? explicit.autoResolveMergeConflicts : null;
}

/** Every branch entry of a repository shares the override; `null` returns it to the instance default. */
export function updateRepositoryAutoResolveMergeConflicts(repos: ManagedRepo[], repoId: string, value: boolean | null): ManagedRepo[] {
  const targetRepo = repos.find(repo => repo.id === repoId);
  if (!targetRepo) return repos;
  const repositoryKey = getRepositoryConfigKey(targetRepo.name);
  return repos.map(repo => getRepositoryConfigKey(repo.name) === repositoryKey
    ? { ...repo, autoResolveMergeConflicts: value }
    : repo);
}

/** Every branch entry of a repository shares one list of non-blocking checks. */
export function updateRepositoryNonBlockingChecks(repos: ManagedRepo[], repoId: string, checks: string[]): ManagedRepo[] {
  const targetRepo = repos.find(repo => repo.id === repoId);
  if (!targetRepo) return repos;
  const repositoryKey = getRepositoryConfigKey(targetRepo.name);
  const nonBlockingChecks = parseWorkflowSelection(checks);
  return repos.map(repo => getRepositoryConfigKey(repo.name) === repositoryKey
    ? { ...repo, nonBlockingChecks }
    : repo);
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

export interface RepositoryAutoAssign {
  enabled: boolean;
  defaultAssignee: string | null;
  requestReview: boolean;
}

/**
 * A default assignee as the server stores it: a GitHub login without the `@`,
 * or `null` for the issue author. Returns `undefined` for an invalid login.
 */
export function parseAutoAssignDefaultAssignee(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const login = value.trim().replace(/^@/, '');
  if (!login) return null;
  return isGitHubLogin(login) ? login : undefined;
}

/**
 * Repository-wide automatic assignment, mirroring the server: an option is on
 * when any branch entry opts in, and the default assignee is the first configured one.
 */
export function resolveRepositoryAutoAssign(repos: readonly ManagedRepo[], repositoryKey: string): RepositoryAutoAssign {
  const entries = repos.filter(repo => getRepositoryConfigKey(repo.name) === repositoryKey);
  return {
    enabled: entries.some(repo => repo.autoAssignPullRequests === true),
    defaultAssignee: entries.map(repo => parseAutoAssignDefaultAssignee(repo.autoAssignDefaultAssignee)).find(login => typeof login === 'string') ?? null,
    requestReview: entries.some(repo => repo.autoAssignRequestReview === true)
  };
}

/** Flip the resolved repository-wide value so every branch entry converges on one state. */
export function toggleRepositoryAutoAssign(repos: ManagedRepo[], repoId: string): ManagedRepo[] {
  const targetRepo = repos.find(repo => repo.id === repoId);
  if (!targetRepo) return repos;
  const repositoryKey = getRepositoryConfigKey(targetRepo.name);
  const autoAssignPullRequests = !resolveRepositoryAutoAssign(repos, repositoryKey).enabled;
  return repos.map(repo => getRepositoryConfigKey(repo.name) === repositoryKey
    ? { ...repo, autoAssignPullRequests }
    : repo);
}

/** Every branch entry of a repository shares one default assignee; `null` assigns the issue author. An invalid login changes nothing. */
export function updateRepositoryAutoAssignTarget(repos: ManagedRepo[], repoId: string, login: string | null): ManagedRepo[] {
  const targetRepo = repos.find(repo => repo.id === repoId);
  if (!targetRepo) return repos;
  const autoAssignDefaultAssignee = parseAutoAssignDefaultAssignee(login);
  if (autoAssignDefaultAssignee === undefined) return repos;
  const repositoryKey = getRepositoryConfigKey(targetRepo.name);
  return repos.map(repo => getRepositoryConfigKey(repo.name) === repositoryKey
    ? { ...repo, autoAssignDefaultAssignee }
    : repo);
}

/** Flip the resolved repository-wide value so every branch entry converges on one state. */
export function toggleRepositoryAutoAssignReview(repos: ManagedRepo[], repoId: string): ManagedRepo[] {
  const targetRepo = repos.find(repo => repo.id === repoId);
  if (!targetRepo) return repos;
  const repositoryKey = getRepositoryConfigKey(targetRepo.name);
  const autoAssignRequestReview = !resolveRepositoryAutoAssign(repos, repositoryKey).requestReview;
  return repos.map(repo => getRepositoryConfigKey(repo.name) === repositoryKey
    ? { ...repo, autoAssignRequestReview }
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
  const nonBlockingChecksByRepository = new Map<string, string[]>();
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
    // Automation honours the union of every branch entry's list, so show that.
    nonBlockingChecksByRepository.set(key, parseWorkflowSelection([
      ...(nonBlockingChecksByRepository.get(key) ?? []),
      ...(Array.isArray(repo.nonBlockingChecks) ? repo.nonBlockingChecks : [])
    ]));
    const previousPreview = visualPreviewByRepository.get(key);
    if (!previousPreview || (!previousPreview.enabled && repo.visualPreview.enabled)) {
      visualPreviewByRepository.set(key, repo.visualPreview);
    }
  }

  return repos.map(repo => {
    const autoAssign = resolveRepositoryAutoAssign(repos, getRepositoryConfigKey(repo.name));
    return {
      ...repo,
      autoAssignPullRequests: autoAssign.enabled,
      autoAssignDefaultAssignee: autoAssign.defaultAssignee,
      autoAssignRequestReview: autoAssign.requestReview,
      autoFollowupOnFailedCi: autoCiFollowupByRepository.get(getRepositoryConfigKey(repo.name)) === true,
      cancelCiDuringFollowup: cancelCiByRepository.get(getRepositoryConfigKey(repo.name)) === true,
      cancelCiDuringFollowupWorkflows: cancelCiWorkflowsByRepository.get(getRepositoryConfigKey(repo.name)) ?? [],
      nonBlockingChecks: nonBlockingChecksByRepository.get(getRepositoryConfigKey(repo.name)) ?? [],
      notificationsEnabled: resolveRepositoryNotificationsEnabled(repos, getRepositoryConfigKey(repo.name)),
      autoResolveMergeConflicts: resolveRepositoryAutoResolveMergeConflicts(repos, getRepositoryConfigKey(repo.name)),
      visualPreview: visualPreviewByRepository.get(getRepositoryConfigKey(repo.name)) || defaultVisualPreview()
    };
  });
}
