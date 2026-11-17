import { PLUGIN_REPOSITORY_PATTERN, PLUGIN_SETTING_OPTIONS_LIMITS, type PluginContext, type PluginSettingOptions, type PluginSettingOptionsInput, type PluginSettingValues } from '@propr/shared';
import { deliveryFailure, listProjects } from './api.js';

/** The Sentry plugin's setting keys. */
export const SENTRY_SETTINGS = {
  baseUrl: 'baseUrl', organization: 'organization', repositoryProjects: 'repositoryProjects', githubLabel: 'githubLabel',
  autoStart: 'autoStart', minEventCount: 'minEventCount', environments: 'environments', dailyCap: 'dailyCap',
  syncOnMerge: 'syncOnMerge', resolveOnMerge: 'resolveOnMerge',
} as const;

export const AUTO_START_DEFAULTS = { minEventCount: 10, environments: ['production'], dailyCap: 3 } as const;

const integer = (value: unknown, fallback: number, min: number, max: number): number =>
  (typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);

export interface AutoStartSettings { enabled: boolean; minEventCount: number; environments: string[]; dailyCap: number }

/** The automatic start settings; anything unset or out of range falls back to the conservative defaults. */
export function autoStartSettings(settings: PluginSettingValues): AutoStartSettings {
  const environments = settings[SENTRY_SETTINGS.environments];
  return {
    enabled: settings[SENTRY_SETTINGS.autoStart] === true,
    minEventCount: integer(settings[SENTRY_SETTINGS.minEventCount], AUTO_START_DEFAULTS.minEventCount, 1, 1_000_000),
    environments: Array.isArray(environments)
      ? [...new Set(environments.filter((e): e is string => typeof e === 'string').map(e => e.trim().toLowerCase()).filter(Boolean))]
      : [...AUTO_START_DEFAULTS.environments],
    dailyCap: integer(settings[SENTRY_SETTINGS.dailyCap], AUTO_START_DEFAULTS.dailyCap, 1, 50),
  };
}

/** Whether merges sync back, and whether they resolve the Sentry issue too (only with the comment on). */
export function syncSettings(settings: PluginSettingValues): { comment: boolean; resolve: boolean } {
  const comment = settings[SENTRY_SETTINGS.syncOnMerge] !== false;
  return { comment, resolve: comment && settings[SENTRY_SETTINGS.resolveOnMerge] === true };
}

export type ProjectMapping = { repository: string; problem: null } | { repository: null; problem: 'unmapped' | 'ambiguous' };

/**
 * The repository an error goes to: the one Repository projects maps its
 * Sentry project to, by slug (letter case aside) or numeric id. A project
 * mapped to several repositories maps nowhere. Only the project counts, never
 * the error's text.
 */
export function projectRepository(settings: PluginSettingValues, project: { id: string | null; slug: string | null }): ProjectMapping {
  const map = settings[SENTRY_SETTINGS.repositoryProjects];
  const entries = map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map) : [];
  const found = [...new Set(entries.filter(([repository, value]) => {
    if (!PLUGIN_REPOSITORY_PATTERN.test(repository) || typeof value !== 'string' || !value.trim()) return false;
    const wanted = value.trim().toLowerCase();
    return (!!project.id && wanted === project.id) || (!!project.slug && wanted === project.slug.toLowerCase());
  }).map(([repository]) => repository))];
  if (found.length === 1) return { repository: found[0], problem: null };
  return { repository: null, problem: found.length ? 'ambiguous' : 'unmapped' };
}

/** Whether some mapping entry could name a project known only by its numeric id (a slug may still match once the issue is read). */
export function mappedById(settings: PluginSettingValues, id: string): boolean {
  return projectRepository(settings, { id, slug: null }).problem !== 'unmapped';
}

const cut = (value: string, chars: number) => { const list = Array.from(value); return list.length > chars ? `${list.slice(0, chars - 1).join('').trimEnd()}…` : value; };

/** Sentry's projects for Repository projects: the slug saved, the name and slug shown. */
export async function settingOptions(input: PluginSettingOptionsInput, ctx: PluginContext): Promise<PluginSettingOptions> {
  try {
    const projects = await listProjects(ctx);
    const options = projects
      .filter(p => p.slug.length <= PLUGIN_SETTING_OPTIONS_LIMITS.valueChars && p.name.trim())
      .map(p => ({ value: p.slug, label: cut(`${p.name.trim()} (${p.slug})`, PLUGIN_SETTING_OPTIONS_LIMITS.labelChars) }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, PLUGIN_SETTING_OPTIONS_LIMITS.options);
    return { options };
  } catch (error) {
    throw deliveryFailure(error, `the list for ${input.setting}`);
  }
}
