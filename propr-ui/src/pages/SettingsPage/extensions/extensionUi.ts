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
/** The value `record` holds under `key` itself; item names are data, never inherited properties such as `constructor`. */
export const ownEntry = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
  (record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
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
/** Candidates that allow exactly the same items, held as a bit set over the enabled items. */
interface CandidateGroup { candidate: Candidate; bits: Uint32Array; size: number }
const popcount = (word: number) => {
  let v = word - ((word >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
/**
 * Groups the candidates by the set of items whose limit allows them, in
 * first-occurrence order. An empty limit allows every candidate; `OTHER`
 * (a value no limit lists) is allowed only by empty limits. Each item's limit
 * is read once, so the cost is linear in the limit entries.
 */
function candidateGroups(limits: readonly string[][], candidates: readonly Candidate[], normalize: (value: string) => string): CandidateGroup[] {
  const words = Math.ceil(limits.length / 32);
  const unlimited = new Uint32Array(words);
  const listing = new Map<string, Uint32Array>();
  limits.forEach((limit, index) => {
    const bit = 1 << (index % 32);
    const word = index >>> 5;
    if (!limit.length) { unlimited[word] |= bit; return; }
    for (const entry of limit) {
      const key = normalize(entry);
      let bits = listing.get(key);
      if (!bits) listing.set(key, bits = new Uint32Array(words));
      bits[word] |= bit;
    }
  });
  const groups = new Map<string, CandidateGroup>();
  for (const candidate of candidates) {
    const listed = candidate === OTHER ? undefined : listing.get(normalize(candidate));
    const bits = unlimited.map((word, i) => word | (listed?.[i] ?? 0));
    const key = bits.join(',');
    if (!groups.has(key)) groups.set(key, { candidate, bits, size: bits.reduce((sum, word) => sum + popcount(word), 0) });
  }
  return [...groups.values()];
}
/**
 * The largest number of enabled items whose limits allow one repository and
 * agent combination, with that combination, when it exceeds what one run uses.
 * Repository names match case-insensitively; agent aliases match exactly.
 */
export function runLimitExcess(items: readonly (ItemLimitFields & { enabled: boolean })[], choices: Pick<ExtensionChoices, 'agents' | 'repositories'>, limit: number) {
  const enabled = items.filter(item => item.enabled);
  if (enabled.length <= limit) return null;
  const repositories = candidateGroups(enabled.map(item => item.repositories),
    [...new Set([...choices.repositories, ...enabled.flatMap(item => item.repositories)]), OTHER], value => value.toLowerCase());
  const agents = candidateGroups(enabled.map(item => item.agents),
    [...new Set([...choices.agents, ...enabled.flatMap(item => item.agents)]), OTHER], value => value);
  let best: { count: number; repository: Candidate; agent: Candidate } | null = null;
  // Groups keep first-occurrence order, so the reported combination is the first one reaching the largest count.
  for (const repository of repositories) {
    if (repository.size <= (best?.count ?? limit)) continue;
    for (const agent of agents) {
      if (agent.size <= (best?.count ?? limit)) continue;
      let count = 0;
      for (let i = 0; i < repository.bits.length; i++) count += popcount(repository.bits[i] & agent.bits[i]);
      if (count > (best?.count ?? limit)) best = { count, repository: repository.candidate, agent: agent.candidate };
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
