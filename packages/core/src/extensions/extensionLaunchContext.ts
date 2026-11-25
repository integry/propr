import { AsyncLocalStorage } from 'node:async_hooks';
import { startsContainer, type AgentRunLaunch } from '../agents/runtime/agentRunLaunch.js';

interface LaunchContext { taskId: string; secrets: string[]; mounts: string[]; beforeLaunch: (window?: object, validateResources?: boolean) => Promise<void> }
export const launchContext = new AsyncLocalStorage<LaunchContext>();
export const currentExtensionLaunch = () => launchContext.getStore();
export function extensionLaunchForRun(command: string, args: string[], options: { taskId?: string; costCapExempt?: boolean; extensionAgentLaunch?: boolean; agentRun?: AgentRunLaunch }) {
  const context = currentExtensionLaunch();
  return context && startsContainer(command, args, options) && options.extensionAgentLaunch === true && options.taskId === context.taskId && !options.costCapExempt ? context : undefined;
}
