import { EXTENSION_LIMITS, type ExtensionLibraryServer, type ExtensionLibrarySkill, type ExtensionLibraryUsage, type InstanceCatalogResponse } from '@propr/shared';
import type { ExtensionItemRef } from '../../../api/extensionProfilesApi';

export const inputClass = 'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
const buttonBase = 'min-h-11 rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50 sm:min-h-0';
export const buttonClass = `${buttonBase} border-slate-300 bg-white hover:bg-slate-50`;
export const dangerButtonClass = `${buttonBase} border-red-300 bg-white text-red-700 hover:bg-red-50`;
export const primaryButtonClass = `${buttonBase} border-teal-700 bg-teal-700 text-white hover:bg-teal-800`;

export type ItemLimitFields = Pick<ExtensionLibrarySkill, 'repositories' | 'agents' | 'autoApply'>;
export type LibraryItem = ExtensionLibraryServer | ExtensionLibrarySkill;
/** New library items apply everywhere and automatically until limited. */
export const NEW_ITEM_LIMITS: ItemLimitFields = { repositories: [], agents: [], autoApply: true };
export const EMPTY_USAGE: ExtensionLibraryUsage = { automations: [], importedFrom: { servers: {}, skills: {} } };

/** Instance choices the item limits offer, and which agent aliases run Codex. */
export interface ExtensionChoices {
  agents: string[];
  codexAgents: string[];
  repositories: string[];
  /** Agent and repository choices could not be loaded. */
  unavailable: boolean;
}
const usableAgent = (agent: InstanceCatalogResponse['agents'][number]) => agent.enabled && agent.kind !== 'synthetic'
  && (agent.type === 'claude' || agent.type === 'codex') && /^[A-Za-z0-9_-]{1,100}$/.test(agent.alias);
export function extensionChoices(catalog: InstanceCatalogResponse, unavailable = false): ExtensionChoices {
  const agents = catalog.agents.filter(usableAgent);
  return {
    agents: agents.map(agent => agent.alias),
    codexAgents: agents.filter(agent => agent.type === 'codex').map(agent => agent.alias),
    repositories: catalog.repositories.map(repository => repository.name),
    unavailable,
  };
}

export const itemRefKey = (ref: ExtensionItemRef) => (ref.kind === 'server' ? `server:${ref.name}` : `skill:${ref.bundleId}`);
export const serverRef = (server: ExtensionLibraryServer): ExtensionItemRef => ({ kind: 'server', name: server.name });
export const skillRef = (skill: ExtensionLibrarySkill): ExtensionItemRef => ({ kind: 'skill', bundleId: skill.bundleId });

export const appliesTo = (item: ItemLimitFields) => (item.repositories.length ? item.repositories.join(', ') : 'All repositories');
/** Whether the item can reach a Codex run: unlimited agents with a Codex agent configured, or a Codex alias in its limit. */
export const appliesToCodex = (item: ItemLimitFields, codexAgents: string[]) =>
  codexAgents.length > 0 && (item.agents.length === 0 || item.agents.some(alias => codexAgents.includes(alias)));

export function nextServerName(servers: { name: string }[]): string {
  let number = 1;
  while (servers.some(server => server.name === `server-${number}`)) number++;
  return `server-${number}`;
}

export function formatSkillSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(Math.floor(Math.log2(bytes) / 10), units.length);
  return `${(bytes / 1024 ** exponent).toFixed(1)} ${units[exponent - 1]}`;
}

const OTHER = Symbol('other');
type Candidate = string | typeof OTHER;
const allows = (limit: string[], value: Candidate, fold = false) => !limit.length
  || (value !== OTHER && limit.some(entry => (fold ? entry.toLowerCase() === value.toLowerCase() : entry === value)));
/**
 * The largest number of enabled items whose limits allow one repository and
 * agent combination, with that combination, when it exceeds what one run uses.
 */
export function runLimitExcess(items: readonly (ItemLimitFields & { enabled: boolean })[], choices: Pick<ExtensionChoices, 'agents' | 'repositories'>, limit: number) {
  const enabled = items.filter(item => item.enabled);
  if (enabled.length <= limit) return null;
  const repositories: Candidate[] = [...new Set([...choices.repositories, ...enabled.flatMap(item => item.repositories)]), OTHER];
  const agents: Candidate[] = [...new Set([...choices.agents, ...enabled.flatMap(item => item.agents)]), OTHER];
  let best: { count: number; repository: Candidate; agent: Candidate } | null = null;
  for (const repository of repositories) {
    for (const agent of agents) {
      const count = enabled.filter(item => allows(item.repositories, repository, true) && allows(item.agents, agent)).length;
      if (count > (best?.count ?? limit)) best = { count, repository, agent };
    }
  }
  if (!best) return null;
  return {
    count: best.count,
    repository: best.repository === OTHER ? 'one repository' : best.repository,
    agent: best.agent === OTHER ? 'one agent' : best.agent,
  };
}
export const RUN_LIMITS = { servers: EXTENSION_LIMITS.servers, skills: EXTENSION_LIMITS.bundles };
