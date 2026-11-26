import { createHash } from 'node:crypto';
import type { ExtensionLibraryServer, ExtensionSkippedItem, ResolvedExtensionSet } from '@propr/shared';
import type { AgentConfig, AgentExtensionRequest } from '../agents/types.js';
import {
  EXTENSION_CLASSES, EXTENSION_CLASS_INFO, extensionClassRefusal, runtimeExtensionCapabilities, type AgentRuntimeExtensionClass, type ResolvedExtensionCapabilities,
} from '../agents/runtime/extensionCapabilities.js';
import { DEFAULT_AGENT_RUNTIME, selectedAgentRuntimeName } from '../agents/runtime/runtimeSelection.js';
import type { AgentNetworkMode } from '../network/networkPolicy.js';
import { tryExtensionGatewayBaseUrl } from './extensionGateway.js';

/** What the run's runtime can do with library items, resolved before any item is prepared. */
export interface ExtensionRuntimeSupport {
  kind: string;
  capabilities: ResolvedExtensionCapabilities;
  /**
   * Skill bundles and package servers are bind-mounted from the worker (Docker).
   * Without bind mounts, skill files are uploaded and package servers are
   * installed inside the sandbox from the worker's verified install.
   */
  bindMounts: boolean;
  /**
   * The ProPR MCP URL the run reaches without a private network: the
   * extension gateway is derived from it so remote runs reach the gateway too.
   */
  mcpEndpoint?: string;
}

const DOCKER_SUPPORT: ExtensionRuntimeSupport = Object.freeze({
  kind: DEFAULT_AGENT_RUNTIME, capabilities: Object.freeze({ skills: true, remoteMcp: true, packageMcp: true, catalogMcp: true }), bindMounts: true,
});

/**
 * The runtime the agent configuration selects and what it applies. Docker is
 * answered without loading any runtime module; other runtimes are loaded
 * lazily, as `runAgent` does at launch.
 */
export async function extensionRuntimeSupport(config: Pick<AgentConfig, 'runtime'>, networkMode: AgentNetworkMode = 'open', environment: NodeJS.ProcessEnv = process.env): Promise<ExtensionRuntimeSupport> {
  if (selectedAgentRuntimeName(config, environment) === DEFAULT_AGENT_RUNTIME) return DOCKER_SUPPORT;
  const { getAgentRuntime } = await import('../agents/runtime/registry.js');
  const runtime = getAgentRuntime(config, environment);
  const capabilities = { ...runtimeExtensionCapabilities(runtime) };
  if (runtime.capabilities.supportsBindMounts && runtime.capabilities.supportsMcpPrivateNetwork) return { kind: runtime.kind, capabilities, bindMounts: true };
  const { planAgentRunMcpTransport } = await import('../agents/runtime/agentRunMcpTransport.js');
  const plan = planAgentRunMcpTransport(runtime, environment, networkMode);
  // Without an endpoint the run reaches, URL servers have no gateway to call.
  // TODO(#3817): once Sprites reach ProPR MCP through the per-run SSH reverse forward
  // (127.0.0.1:39080 -> internal API) when there is no public URL, point the gateway
  // at that forward's /api/extensions/mcp instead of treating URL servers as unsupported.
  // The gateway sits beside ProPR MCP: an endpoint it cannot be derived from
  // (a proxy path not ending in /api/mcp) leaves URL servers unsupported too.
  const mcpEndpoint = plan.transport === 'reachable-url' ? plan.url : undefined;
  if (!mcpEndpoint || !tryExtensionGatewayBaseUrl(environment, mcpEndpoint)) capabilities.remoteMcp = false;
  return { kind: runtime.kind, capabilities, bindMounts: runtime.capabilities.supportsBindMounts, ...(mcpEndpoint ? { mcpEndpoint } : {}) };
}

/**
 * URL servers (direct or operator catalog over HTTPS) need only network reach.
 * Package servers are installed next to the agent; operator catalog stdio
 * servers run an executable that must already be in the run's image.
 */
export type ServerClassifier = (server: ExtensionLibraryServer) => Promise<AgentRuntimeExtensionClass | 'unavailable'> | AgentRuntimeExtensionClass | 'unavailable';
export const serverExtensionClass = (server: ExtensionLibraryServer, catalogKind?: 'stdio' | 'https'): AgentRuntimeExtensionClass =>
  server.kind === 'package' ? 'packageMcp' : server.kind === 'catalog' && catalogKind === 'stdio' ? 'catalogMcp' : 'remoteMcp';

export interface ExtensionRuntimeDrop {
  runtime: string;
  servers: string[];
  skills: string[];
  message: string;
}

/**
 * The set without the items this runtime cannot apply. An explicitly added
 * item of such a class refuses the run with the capability error naming it;
 * an auto-applied one is dropped for this run, recorded as skipped, and named
 * in the returned note so the run's events and comment can say so.
 */
export async function applyRuntimeSupport(set: ResolvedExtensionSet, request: AgentExtensionRequest, support: ExtensionRuntimeSupport, classify: ServerClassifier): Promise<{ set: ResolvedExtensionSet; dropped?: ExtensionRuntimeDrop }> {
  const { capabilities, kind } = support;
  if (EXTENSION_CLASSES.every(extensionClass => capabilities[extensionClass])) return { set };
  const runtime = { kind, capabilities: { extensions: capabilities } };
  const unsupportedServers = new Map<string, AgentRuntimeExtensionClass>();
  for (const server of set.servers) {
    const extensionClass = await classify(server);
    // An unavailable server (a catalog entry that no longer resolves) is not a runtime gap: it fails at launch as on Docker.
    if (extensionClass !== 'unavailable' && !capabilities[extensionClass]) unsupportedServers.set(server.name, extensionClass);
  }
  const unsupportedSkills = capabilities.skills ? [] : set.skills;
  // Explicit items keep their strict behaviour: refused, never silently dropped.
  for (const extensionClass of ['remoteMcp', 'packageMcp', 'catalogMcp'] as const) {
    const explicit = [...unsupportedServers].filter(([name, c]) => c === extensionClass && request.servers.includes(name)).map(([name]) => name);
    if (explicit.length) throw extensionClassRefusal(runtime, extensionClass, explicit);
  }
  const explicitSkills = unsupportedSkills.filter(skill => request.skills.includes(skill.bundleId)).map(skill => skill.bundle.name);
  if (explicitSkills.length) throw extensionClassRefusal(runtime, 'skills', explicitSkills);
  if (!unsupportedServers.size && !unsupportedSkills.length) return { set };
  const skipped: ExtensionSkippedItem[] = [
    ...[...unsupportedServers.keys()].map(name => ({ kind: 'server' as const, name, reason: 'agent_runtime_unsupported' as const, source: 'auto' as const })),
    ...unsupportedSkills.map(skill => ({ kind: 'skill' as const, name: skill.bundleId, label: skill.bundle.name, reason: 'agent_runtime_unsupported' as const, source: 'auto' as const })),
  ];
  const servers = [...unsupportedServers.keys()];
  const skills = unsupportedSkills.map(skill => skill.bundle.name);
  const classes = [...new Set([...unsupportedServers.values(), ...(unsupportedSkills.length ? ['skills' as const] : [])])].map(c => EXTENSION_CLASS_INFO[c].label);
  const names = [...servers.map(name => `MCP server "${name}"`), ...skills.map(name => `skill bundle "${name}"`)].join(', ');
  return {
    set: { ...set, servers: set.servers.filter(s => !unsupportedServers.has(s.name)), skills: capabilities.skills ? set.skills : [], skipped: [...set.skipped, ...skipped] },
    dropped: { runtime: kind, servers, skills, message: `Agent runtime "${kind}" cannot run ${classes.join(' or ')}, so this run launched without these auto-applied Extension Library items: ${names}.` },
  };
}

/** One note for the items a remote run launched without: runtime gaps and package servers whose install cannot travel. */
export function mergeRuntimeDrops(runtime: string, ...drops: ({ servers: string[]; skills?: string[]; message: string } | undefined)[]): ExtensionRuntimeDrop | undefined {
  const present = drops.filter(drop => drop !== undefined);
  if (!present.length) return undefined;
  return { runtime, servers: present.flatMap(drop => drop.servers), skills: present.flatMap(drop => drop.skills ?? []), message: present.map(drop => drop.message).join(' ') };
}

/** The Markdown note a run's issue or pull request comment carries for dropped items. */
export const extensionRuntimeDropNotice = (dropped: ExtensionRuntimeDrop) =>
  `> [!NOTE]\n> ${dropped.message} Run the agent on the docker runtime to apply them.`;

/** One value for the items a run applies: equal servers and skill bundle contents give the same digest. */
export function extensionSetDigest(set: Pick<ResolvedExtensionSet, 'servers' | 'skills'>): string {
  const servers = set.servers.map(server => JSON.stringify(server)).sort();
  const skills = set.skills.map(skill => `${skill.bundleId}:${skill.bundle.digest}`).sort();
  return createHash('sha256').update(JSON.stringify({ servers, skills })).digest('hex').slice(0, 16);
}

/** Fields of the per-run log line: the extension digest and how many items of each class the run carries. */
export function extensionApplicationLog(run: { taskId: string; runtime: string; revision: number; set: Pick<ResolvedExtensionSet, 'servers' | 'skills'>;
  requires: Record<AgentRuntimeExtensionClass, readonly string[]>; packageFields: Record<string, unknown> }) {
  const { requires } = run;
  return { taskId: run.taskId, runtime: run.runtime, revision: run.revision, extensionDigest: extensionSetDigest(run.set), skills: requires.skills.length,
    urlServers: requires.remoteMcp.length, catalogStdioServers: requires.catalogMcp.length, ...run.packageFields, packageServers: requires.packageMcp.length };
}
