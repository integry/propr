import { PLUGIN_REPOSITORY_PATTERN, PLUGIN_SETTING_OPTIONS_LIMITS, type PluginContext, type PluginSettingOption, type PluginSettingOptions, type PluginSettingOptionsInput, type PluginSettingValues } from '@propr/shared';
import { LIST_PROJECTS, LIST_STATES, LIST_TEAMS, deliveryFailure, linearGraphql } from './api.js';

/** The Linear plugin's setting keys. */
export const LINEAR_SETTINGS = {
  repositoryTeams: 'repositoryTeams', repositoryProjects: 'repositoryProjects', triggerLabel: 'triggerLabel', githubLabel: 'githubLabel',
  syncEvents: 'syncEvents', openedState: 'openedState', mergedState: 'mergedState',
} as const;
export const DEFAULT_LINEAR_TRIGGER_LABEL = 'propr';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The Linear label that hands a ticket to ProPR (compared without letter case). */
export const linearTriggerLabel = (settings: PluginSettingValues): string => text(settings[LINEAR_SETTINGS.triggerLabel]) || DEFAULT_LINEAR_TRIGGER_LABEL;

/** The repositories a repository map sends `matches` to. */
function mappedRepositories(settings: PluginSettingValues, key: string, matches: (value: string) => boolean): string[] {
  const map = settings[key];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return [...new Set(Object.entries(map).filter(([repository, value]) => PLUGIN_REPOSITORY_PATTERN.test(repository) && typeof value === 'string' && value.trim() && matches(value.trim())).map(([repository]) => repository))];
}

/** Linear ids are UUIDs; a team key is short (ENG). */
const LINEAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether Repository teams maps some repository by team key rather than team id. */
export function teamsMappedByKey(settings: PluginSettingValues): boolean {
  const map = settings[LINEAR_SETTINGS.repositoryTeams];
  return !!map && typeof map === 'object' && !Array.isArray(map) && Object.values(map).some(value => typeof value === 'string' && value.trim() !== '' && !LINEAR_ID.test(value.trim()));
}

export type TicketMapping = { repository: string; problem: null } | { repository: null; problem: 'unmapped' | 'ambiguous' };

/**
 * The repository a ticket goes to: the one Repository projects maps its
 * project to, else the one Repository teams maps its team to (by team id, or
 * by key). A project or team mapped to several repositories maps nowhere.
 * Only the ticket's team and project count, never its text.
 */
export function ticketRepository(settings: PluginSettingValues, ticket: { teamId: string | null; teamKey: string | null; projectId: string | null }): TicketMapping {
  const byProject = ticket.projectId ? mappedRepositories(settings, LINEAR_SETTINGS.repositoryProjects, value => value === ticket.projectId) : [];
  const byTeam = byProject.length ? [] : mappedRepositories(settings, LINEAR_SETTINGS.repositoryTeams, value => value === ticket.teamId || (!!ticket.teamKey && value.toUpperCase() === ticket.teamKey.toUpperCase()));
  const found = byProject.length ? byProject : byTeam;
  if (found.length === 1) return { repository: found[0], problem: null };
  return { repository: null, problem: found.length ? 'ambiguous' : 'unmapped' };
}

type Nodes<T> = { nodes?: T[] } | null | undefined;
const nodes = <T>(value: Nodes<T>): T[] => (Array.isArray(value?.nodes) ? value!.nodes : []);
const byLabel = (a: PluginSettingOption, b: PluginSettingOption) => a.label.localeCompare(b.label);
const cut = (text: string, chars: number) => { const list = Array.from(text); return list.length > chars ? `${list.slice(0, chars - 1).join('').trimEnd()}…` : text; };
/** The choices within the options contract: values Linear gave that fit, labels shortened, at most the allowed count. */
const withinLimits = (options: PluginSettingOption[]): PluginSettingOption[] => options
  .filter(option => typeof option.value === 'string' && option.value && option.value.length <= PLUGIN_SETTING_OPTIONS_LIMITS.valueChars && typeof option.label === 'string' && option.label.trim())
  .map(option => ({ value: option.value, label: cut(option.label.trim(), PLUGIN_SETTING_OPTIONS_LIMITS.labelChars) }))
  .slice(0, PLUGIN_SETTING_OPTIONS_LIMITS.options);

/** Linear's teams for Repository teams: the team id saved, its name and key shown. */
async function teamOptions(ctx: PluginContext): Promise<PluginSettingOption[]> {
  const data = await linearGraphql<{ teams: Nodes<{ id: string; key: string; name: string }> }>(ctx, LIST_TEAMS);
  return nodes(data.teams).map(team => ({ value: team.id, label: `${team.name} (${team.key})` })).sort(byLabel);
}

/** Linear's projects for Repository projects: the project id saved, its name shown. */
async function projectOptions(ctx: PluginContext): Promise<PluginSettingOption[]> {
  const data = await linearGraphql<{ projects: Nodes<{ id: string; name: string }> }>(ctx, LIST_PROJECTS);
  return nodes(data.projects).map(project => ({ value: project.id, label: project.name })).sort(byLabel);
}

/**
 * Linear's workflow state names for the state moves: each name once, with the
 * teams that have it. A state is chosen by name because each team has its
 * own states; the move looks the name up in the ticket's team.
 */
async function stateOptions(ctx: PluginContext): Promise<PluginSettingOption[]> {
  const data = await linearGraphql<{ workflowStates: Nodes<{ id: string; name: string; team?: { key?: string } | null }> }>(ctx, LIST_STATES);
  const teams = new Map<string, Set<string>>();
  for (const state of nodes(data.workflowStates)) {
    if (typeof state.name !== 'string' || !state.name.trim()) continue;
    const set = teams.get(state.name) ?? new Set<string>();
    if (state.team?.key) set.add(state.team.key);
    teams.set(state.name, set);
  }
  return [...teams].map(([name, keys]) => ({ value: name, label: keys.size ? `${name} (${[...keys].sort().join(', ')})` : name })).sort(byLabel);
}

const LOADERS: Record<string, (ctx: PluginContext) => Promise<PluginSettingOption[]>> = { teamOptions, projectOptions, stateOptions };

/** Run one options loader; Linear's refusal becomes a message the form shows. */
export async function settingOptions(loader: keyof typeof LOADERS, input: PluginSettingOptionsInput, ctx: PluginContext): Promise<PluginSettingOptions> {
  try {
    return { options: withinLimits(await LOADERS[loader](ctx)) };
  } catch (error) {
    throw deliveryFailure(error, `the list for ${input.setting}`);
  }
}
