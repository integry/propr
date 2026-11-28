import type { AgentType } from './modelDefinitions.js';

/**
 * What one agent runtime can receive at launch. Every extension and ProPR MCP
 * gate reads this map, so a runtime is turned on in one place.
 *
 * - `extensions`: instance extension library items (MCP servers and skill bundles).
 * - `proprMcp`: the run-scoped ProPR MCP server (automations, agent definitions).
 * - `skills`: how skill bundles reach the agent. `prompt` stages them read-only at
 *   `/opt/propr/extensions/<id>/SKILL.md` with a prompt pointer; `native` also
 *   registers them through the runtime's own skill mechanism.
 */
export interface AgentRuntimeCapabilities {
  extensions: boolean;
  proprMcp: boolean;
  skills: 'native' | 'prompt';
}

/** A CLI-version condition: versions below `minMajor` do not have the capabilities. */
export interface AgentRuntimeCliVersionPredicate {
  minMajor: number;
}

export interface AgentRuntimeCapabilityEntry extends AgentRuntimeCapabilities {
  /** Optional CLI-version predicate; a known version that fails it has no capabilities. */
  cliVersion?: AgentRuntimeCliVersionPredicate;
}

const NONE: AgentRuntimeCapabilities = { extensions: false, proprMcp: false, skills: 'prompt' };

/**
 * The runtime capability map. Claude, Codex, Antigravity, OpenCode 2.x and
 * Vibe are supported. OpenCode 1.x ignores the 2.x `mcp.servers` and
 * `skills.paths` config, so its entry carries the 2.x predicate.
 */
export const AGENT_RUNTIME_CAPABILITIES: Readonly<Record<AgentType, Readonly<AgentRuntimeCapabilityEntry>>> = {
  claude: { extensions: true, proprMcp: true, skills: 'prompt' },
  codex: { extensions: true, proprMcp: true, skills: 'prompt' },
  // Skill bundles are also copied into `<runtime HOME>/.gemini/skills/<name>`.
  antigravity: { extensions: true, proprMcp: true, skills: 'native' },
  // OpenCode 2.x loads staged bundles through its own `skill` tool (`skills.paths`).
  opencode: { extensions: true, proprMcp: true, skills: 'native', cliVersion: { minMajor: 2 } },
  // Vibe registers staged bundles through its own `skill` tool (VIBE_SKILL_PATHS).
  vibe: { extensions: true, proprMcp: true, skills: 'native' },
};

const RUNTIME_LABELS: Record<AgentType, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode', vibe: 'Vibe' };

const isAgentType = (value: unknown): value is AgentType => typeof value === 'string' && Object.hasOwn(AGENT_RUNTIME_CAPABILITIES, value);

/** Major version of a semver-like CLI version, or null when it is not a concrete version (`latest`, `stable`, empty). */
function cliMajor(version: string | null | undefined): number | null {
  const match = /^v?(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/.exec((version ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * The capabilities of one runtime, optionally at a CLI version. Unknown types
 * have none. A concrete version that fails the entry's predicate has none;
 * without a concrete version the mapped entry applies.
 */
export function agentRuntimeCapabilities(agentType: unknown, cliVersion?: string | null): AgentRuntimeCapabilities {
  if (!isAgentType(agentType)) return { ...NONE };
  const entry = AGENT_RUNTIME_CAPABILITIES[agentType];
  const major = cliMajor(cliVersion);
  if (entry.cliVersion && major !== null && major < entry.cliVersion.minMajor) return { ...NONE };
  return { extensions: entry.extensions, proprMcp: entry.proprMcp, skills: entry.skills };
}

export const agentRuntimeSupportsExtensions = (agentType: unknown, cliVersion?: string | null): boolean => agentRuntimeCapabilities(agentType, cliVersion).extensions;
export const agentRuntimeSupportsProprMcp = (agentType: unknown, cliVersion?: string | null): boolean => agentRuntimeCapabilities(agentType, cliVersion).proprMcp;

const typesWith = (capability: 'extensions' | 'proprMcp'): AgentType[] => (Object.keys(AGENT_RUNTIME_CAPABILITIES) as AgentType[]).filter(type => AGENT_RUNTIME_CAPABILITIES[type][capability]);

/** Agent types whose runtime resolves extension library items, in map order. */
export const EXTENSION_AGENT_TYPES: readonly AgentType[] = Object.freeze(typesWith('extensions'));
/** Agent types that can receive the ProPR MCP server config at launch, in map order. */
export const PROPR_MCP_AGENT_TYPES: readonly AgentType[] = Object.freeze(typesWith('proprMcp'));

/** Short runtime name for messages ("Claude", "OpenCode"). */
export const agentRuntimeLabel = (agentType: unknown): string => (isAgentType(agentType) ? RUNTIME_LABELS[agentType] : String(agentType ?? ''));

/** "Claude or Codex": the runtimes that support extensions, for refusal messages. */
export function extensionRuntimesLabel(): string {
  const names = EXTENSION_AGENT_TYPES.map(type => RUNTIME_LABELS[type]);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** The refusal for explicitly added extensions on a runtime without support. */
export const unsupportedExtensionRuntimeMessage = (): string => `Extensions require ${extensionRuntimesLabel()} task execution`;
