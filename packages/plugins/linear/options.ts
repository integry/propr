import type { PluginContext, PluginSettingOption, PluginSettingOptionsResult } from '@propr/shared';
import { LinearApiError, listProjects, listTeams, listWorkflowStates } from './api.js';
import { mappingValue } from './settings.js';

/**
 * The configure form's choices, read from Linear with the saved API key
 * (`optionsFrom` handlers): the teams and projects a repository can be mapped
 * to, and the workflow state names a ticket can be moved to. Without an API
 * key, or with one Linear refuses, the form is told what to set.
 */

const NOT_CONNECTED = 'Set the Linear API key under Connections (a personal API key with Read and Write access), then load the choices again.';
const REFUSED = 'Linear refused the API key. Set a valid personal API key under Connections, then load the choices again.';

async function choices(ctx: PluginContext, read: () => Promise<PluginSettingOption[]>): Promise<PluginSettingOptionsResult> {
  try {
    return { options: await read() };
  } catch (error) {
    if (error instanceof LinearApiError && error.notConnected) return { notConnected: error.code === 'not_connected' ? NOT_CONNECTED : REFUSED };
    if (error instanceof LinearApiError) throw new Error(`Linear answered ${error.code}${error.permanent ? '' : '; try again shortly'}`);
    throw error;
  }
}

const byLabel = (a: PluginSettingOption, b: PluginSettingOption) => a.label.localeCompare(b.label);

/** Teams (`team:<id>`) and projects (`project:<id>`) for Repository mapping. */
export const teamAndProjectOptions = (ctx: PluginContext) => choices(ctx, async () => {
  const [teams, projects] = await Promise.all([listTeams(ctx), listProjects(ctx)]);
  return [
    ...teams.map(team => ({ value: mappingValue('team', team.id), label: `Team: ${team.name}${team.key ? ` (${team.key})` : ''}` })).sort(byLabel),
    ...projects.map(project => ({ value: mappingValue('project', project.id), label: `Project: ${project.name}` })).sort(byLabel),
  ];
});

/** Workflow state names, each once, with the teams that have it. A ticket moves to the state of that name in its own team. */
export const workflowStateOptions = (ctx: PluginContext) => choices(ctx, async () => {
  const teams = new Map<string, { name: string; teams: Set<string> }>();
  for (const state of await listWorkflowStates(ctx)) {
    const name = state.name.trim();
    if (!name) continue;
    const entry = teams.get(name.toLowerCase()) ?? { name, teams: new Set<string>() };
    if (state.team?.key) entry.teams.add(state.team.key);
    teams.set(name.toLowerCase(), entry);
  }
  return [...teams.values()].map(({ name, teams: keys }) => ({ value: name, label: keys.size ? `${name} (${[...keys].sort().join(', ')})` : name })).sort(byLabel);
});
