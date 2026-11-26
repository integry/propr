import type { ExtensionLibraryServer, ExtensionSkippedItem, ResolvedExtensionSet } from '@propr/shared';
import type { AgentConfig, AgentExtensionRequest } from '../agents/types.js';
import {
  EXTENSION_CLASS_INFO, extensionClassRefusal, runtimeExtensionCapabilities, type AgentRuntimeExtensionClass,
} from '../agents/runtime/extensionCapabilities.js';
import { DEFAULT_AGENT_RUNTIME, selectedAgentRuntimeName } from '../agents/runtime/runtimeSelection.js';
import type { AgentNetworkMode } from '../network/networkPolicy.js';
import type { AgentRuntimeExtensionCapabilities } from '../agents/runtime/types.js';

/** What the run's runtime can do with library items, resolved before any item is prepared. */
export interface ExtensionRuntimeSupport {
  kind: string;
  capabilities: AgentRuntimeExtensionCapabilities;
  /** Skill bundles are bind-mounted from the worker's staging directory (Docker) rather than uploaded. */
  bindsSkills: boolean;
  /**
   * The ProPR MCP URL the run reaches without a private network: the
   * extension gateway is derived from it so remote runs reach the gateway too.
   */
  mcpEndpoint?: string;
}

const DOCKER_SUPPORT: ExtensionRuntimeSupport = Object.freeze({
  kind: DEFAULT_AGENT_RUNTIME, capabilities: Object.freeze({ skills: true, remoteMcp: true, packageMcp: true }), bindsSkills: true,
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
  if (runtime.capabilities.supportsBindMounts && runtime.capabilities.supportsMcpPrivateNetwork) return { kind: runtime.kind, capabilities, bindsSkills: true };
  const { planAgentRunMcpTransport } = await import('../agents/runtime/agentRunMcpTransport.js');
  const plan = planAgentRunMcpTransport(runtime, environment, networkMode);
  // Without an endpoint the run reaches, URL servers have no gateway to call.
  if (plan.transport !== 'reachable-url') capabilities.remoteMcp = false;
  return { kind: runtime.kind, capabilities, bindsSkills: runtime.capabilities.supportsBindMounts, ...(plan.transport === 'reachable-url' ? { mcpEndpoint: plan.url } : {}) };
}

/** URL servers (direct or operator catalog over HTTPS) need only network reach; package and catalog stdio servers run locally. */
export type ServerClassifier = (server: ExtensionLibraryServer) => Promise<AgentRuntimeExtensionClass> | AgentRuntimeExtensionClass;
export const serverExtensionClass = (server: ExtensionLibraryServer, catalogKind?: 'stdio' | 'https'): AgentRuntimeExtensionClass =>
  server.kind === 'package' || (server.kind === 'catalog' && catalogKind === 'stdio') ? 'packageMcp' : 'remoteMcp';

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
  if (capabilities.skills && capabilities.remoteMcp && capabilities.packageMcp) return { set };
  const runtime = { kind, capabilities: { extensions: capabilities } };
  const unsupportedServers = new Map<string, AgentRuntimeExtensionClass>();
  for (const server of set.servers) {
    const extensionClass = await classify(server);
    if (!capabilities[extensionClass]) unsupportedServers.set(server.name, extensionClass);
  }
  const unsupportedSkills = capabilities.skills ? [] : set.skills;
  // Explicit items keep their strict behaviour: refused, never silently dropped.
  for (const extensionClass of ['remoteMcp', 'packageMcp'] as const) {
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

/** The Markdown note a run's issue or pull request comment carries for dropped items. */
export const extensionRuntimeDropNotice = (dropped: ExtensionRuntimeDrop) =>
  `> [!NOTE]\n> ${dropped.message} Run the agent on the docker runtime to apply them.`;
