import { PLUGIN_REPOSITORY_PATTERN, PluginDeliveryError, type PluginSettingValues } from '@propr/shared';

/** The Linear plugin's setting keys and how they are read. */
export const LINEAR_SETTINGS = {
  repositoryMapping: 'repositoryMapping', triggerLabel: 'triggerLabel', issueLabel: 'issueLabel',
  comments: 'comments', stateOnPullRequestOpened: 'stateOnPullRequestOpened', stateOnMerged: 'stateOnMerged',
} as const;
export const DEFAULT_TRIGGER_LABEL = 'propr';
export const DEFAULT_ISSUE_LABEL = 'AI';

/** A label ProPR could use as a trigger: no commas, no control characters, at most 50 characters. */
const LABEL = /^[^\s,\x00-\x1f\x7f][^,\x00-\x1f\x7f]{0,49}$/;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A mapping value: `team:<id>` or `project:<id>`. */
export const mappingValue = (kind: 'team' | 'project', id: string) => `${kind}:${id}`;

/** The repositories Repository mapping maps the value to (compared without letter case). */
export function mappedRepositories(settings: PluginSettingValues, value: string): string[] {
  const map = settings[LINEAR_SETTINGS.repositoryMapping];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const wanted = value.toLowerCase();
  return [...new Set(Object.entries(map)
    .filter(([repository, entry]) => PLUGIN_REPOSITORY_PATTERN.test(repository) && typeof entry === 'string' && entry.trim().toLowerCase() === wanted)
    .map(([repository]) => repository))];
}

/** Whether any repository is mapped at all (an event in a repository no ticket can come from needs no lookups). */
export function repositoryMapped(settings: PluginSettingValues, repository: string): boolean {
  const map = settings[LINEAR_SETTINGS.repositoryMapping];
  return !!map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).some(key => key.toLowerCase() === repository.toLowerCase());
}

/** A label setting, checked: an unusable one fails the delivery rather than create an issue nothing picks up. */
export function labelSetting(settings: PluginSettingValues, key: string, fallback: string): string {
  const label = text(settings[key]) || fallback;
  if (!LABEL.test(label)) throw new PluginDeliveryError(`The ${key} setting is not a usable label (no commas, at most 50 characters). Fix the plugin's settings`, { permanent: true });
  return label;
}
