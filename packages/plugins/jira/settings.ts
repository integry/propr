import { PLUGIN_REPOSITORY_PATTERN, PLUGIN_SETTING_OPTIONS_LIMITS, PluginDeliveryError, type PluginContext, type PluginSettingOption, type PluginSettingOptions, type PluginSettingOptionsInput, type PluginSettingValues } from '@propr/shared';
import { PROJECT_REFERENCE, deliveryFailure, listProjects, projectStatuses } from './api.js';

/** The Jira plugin's setting keys. */
export const JIRA_SETTINGS = {
  siteUrl: 'siteUrl', repositoryProjects: 'repositoryProjects', triggerLabel: 'triggerLabel', githubLabel: 'githubLabel',
  syncEvents: 'syncEvents', openedState: 'openedState', mergedState: 'mergedState',
} as const;
export const DEFAULT_JIRA_TRIGGER_LABEL = 'propr';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The Jira label that hands a ticket to ProPR (compared without letter case). */
export const jiraTriggerLabel = (settings: PluginSettingValues): string => text(settings[JIRA_SETTINGS.triggerLabel]) || DEFAULT_JIRA_TRIGGER_LABEL;

/** The project references (keys or ids) Repository projects maps some repository to. */
export function mappedProjects(settings: PluginSettingValues): string[] {
  const map = settings[JIRA_SETTINGS.repositoryProjects];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return [...new Set(Object.entries(map).filter(([repository, value]) => PLUGIN_REPOSITORY_PATTERN.test(repository) && typeof value === 'string' && PROJECT_REFERENCE.test(value.trim())).map(([, value]) => (value as string).trim()))];
}

export type TicketMapping = { repository: string; problem: null } | { repository: null; problem: 'unmapped' | 'ambiguous' };

/**
 * The repository a ticket goes to: the one Repository projects maps its
 * project to, by project key (letter case aside) or project id. A project
 * mapped to several repositories maps nowhere. Only the ticket's project
 * counts, never its text.
 */
export function ticketRepository(settings: PluginSettingValues, project: { id: string | null; key: string | null }): TicketMapping {
  const map = settings[JIRA_SETTINGS.repositoryProjects];
  const entries = map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map) : [];
  const found = [...new Set(entries.filter(([repository, value]) => {
    if (!PLUGIN_REPOSITORY_PATTERN.test(repository) || typeof value !== 'string' || !value.trim()) return false;
    const wanted = value.trim();
    return (!!project.id && wanted === project.id) || (!!project.key && wanted.toUpperCase() === project.key.toUpperCase());
  }).map(([repository]) => repository))];
  if (found.length === 1) return { repository: found[0], problem: null };
  return { repository: null, problem: found.length ? 'ambiguous' : 'unmapped' };
}

const byLabel = (a: PluginSettingOption, b: PluginSettingOption) => a.label.localeCompare(b.label);
const cut = (value: string, chars: number) => { const list = Array.from(value); return list.length > chars ? `${list.slice(0, chars - 1).join('').trimEnd()}…` : value; };
/** The choices within the options contract: values Jira gave that fit, labels shortened, at most the allowed count. */
const withinLimits = (options: PluginSettingOption[]): PluginSettingOption[] => options
  .filter(option => typeof option.value === 'string' && option.value && option.value.length <= PLUGIN_SETTING_OPTIONS_LIMITS.valueChars && typeof option.label === 'string' && option.label.trim())
  .map(option => ({ value: option.value, label: cut(option.label.trim(), PLUGIN_SETTING_OPTIONS_LIMITS.labelChars) }))
  .slice(0, PLUGIN_SETTING_OPTIONS_LIMITS.options);

/** Jira's projects for Repository projects: the project key saved, its name and key shown. */
async function projectOptions(ctx: PluginContext): Promise<PluginSettingOption[]> {
  const projects = await listProjects(ctx, PLUGIN_SETTING_OPTIONS_LIMITS.options);
  return projects.filter(p => PROJECT_REFERENCE.test(p.key)).map(p => ({ value: p.key, label: `${p.name} (${p.key})` })).sort(byLabel);
}

/** How many mapped projects' workflows the status choices are read from. */
export const STATUS_PROJECTS_LIMIT = 20;

/**
 * The status names of the mapped projects' workflows, for the state moves:
 * each name once, with the projects that have it. A status is chosen by name
 * because each project has its own workflow; the move looks for a transition
 * to that status from the ticket's current one.
 */
async function stateOptions(ctx: PluginContext): Promise<PluginSettingOption[]> {
  const projects = mappedProjects(ctx.settings).slice(0, STATUS_PROJECTS_LIMIT);
  if (!projects.length) throw new PluginDeliveryError('Map a repository to a Jira project under Repository projects and save first, then choose Reload choices: the statuses come from the mapped projects\' workflows.', { permanent: true });
  const owners = new Map<string, Set<string>>();
  for (const project of projects) {
    for (const name of await projectStatuses(ctx, project)) {
      const set = owners.get(name) ?? new Set<string>();
      set.add(project.toUpperCase());
      owners.set(name, set);
    }
  }
  return [...owners].map(([name, keys]) => ({ value: name, label: `${name} (${[...keys].sort().join(', ')})` })).sort(byLabel);
}

const LOADERS: Record<string, (ctx: PluginContext) => Promise<PluginSettingOption[]>> = { projectOptions, stateOptions };

/** Run one options loader; Jira's refusal becomes a message the form shows. */
export async function settingOptions(loader: keyof typeof LOADERS, input: PluginSettingOptionsInput, ctx: PluginContext): Promise<PluginSettingOptions> {
  try {
    return { options: withinLimits(await LOADERS[loader](ctx)) };
  } catch (error) {
    throw deliveryFailure(error, `the list for ${input.setting}`);
  }
}
