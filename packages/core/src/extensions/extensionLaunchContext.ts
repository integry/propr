import { AsyncLocalStorage } from 'node:async_hooks';
import { startsContainer, type AgentRunLaunch } from '../agents/runtime/agentRunLaunch.js';
import type { ExtensionLaunchRequirements } from '../agents/runtime/extensionCapabilities.js';

/** One validated skill bundle file, relative to {@link EXTENSION_SKILLS_ROOT}. */
export interface ExtensionSkillFile { path: string; content: Buffer }
/** Where library skill bundles are readable in every runtime: `<root>/<bundle id>/SKILL.md`. */
export const EXTENSION_SKILLS_ROOT = '/opt/propr/extensions';

interface LaunchContext {
  taskId: string; secrets: string[];
  /** Docker CLI mount arguments (skill staging and package mounts). */
  mounts: string[];
  beforeLaunch: (window?: object, validateResources?: boolean) => Promise<void>;
  /** Item names by class; a runtime refuses only the classes it cannot apply. Absent means every class. */
  requires?: ExtensionLaunchRequirements;
  /** Validated skill bundle files, for runtimes that upload them instead of bind-mounting the staging directory. */
  skillFiles?: readonly ExtensionSkillFile[];
  /** The extension gateway URL the run's URL MCP servers point at, so a restricted runtime can allow its host. */
  gatewayUrl?: string;
}
export const launchContext = new AsyncLocalStorage<LaunchContext>();
export const currentExtensionLaunch = () => launchContext.getStore();
export function extensionLaunchForRun(command: string, args: string[], options: { taskId?: string; costCapExempt?: boolean; extensionAgentLaunch?: boolean; agentRun?: AgentRunLaunch }) {
  const context = currentExtensionLaunch();
  return context && startsContainer(command, args, options) && options.extensionAgentLaunch === true && options.taskId === context.taskId && !options.costCapExempt ? context : undefined;
}
