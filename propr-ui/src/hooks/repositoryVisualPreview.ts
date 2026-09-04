import type { MonitoredRepo } from '../api/proprApi';

export type VisualPreviewSettings = NonNullable<MonitoredRepo['visualPreview']>;

export type ManagedRepo = Omit<MonitoredRepo, 'autoFollowupOnFailedCi' | 'visualPreview'> & {
  autoFollowupOnFailedCi: boolean;
  visualPreview: VisualPreviewSettings;
};

export const getRepositoryConfigKey = (name: string): string => name.trim().toLowerCase();

export const defaultVisualPreview = (): VisualPreviewSettings => ({ enabled: false, types: ['image'] });

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

export function buildRepositoriesForDisplay(repos: ManagedRepo[]): ManagedRepo[] {
  const autoCiFollowupByRepository = new Map<string, boolean>();
  const visualPreviewByRepository = new Map<string, VisualPreviewSettings>();
  for (const repo of repos) {
    const key = getRepositoryConfigKey(repo.name);
    autoCiFollowupByRepository.set(key, autoCiFollowupByRepository.get(key) === true || repo.autoFollowupOnFailedCi);
    const previousPreview = visualPreviewByRepository.get(key);
    if (!previousPreview || (!previousPreview.enabled && repo.visualPreview.enabled)) {
      visualPreviewByRepository.set(key, repo.visualPreview);
    }
  }

  return repos.map(repo => ({
    ...repo,
    autoFollowupOnFailedCi: autoCiFollowupByRepository.get(getRepositoryConfigKey(repo.name)) === true,
    visualPreview: visualPreviewByRepository.get(getRepositoryConfigKey(repo.name)) || defaultVisualPreview()
  }));
}
