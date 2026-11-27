import type { AgentType } from '@propr/shared';
import { claudeToolPolicyArgs } from './claudeMcpLaunch.js';
import { codexToolPolicyArgs } from './codexMcpLaunch.js';
import { antigravityToolPolicyArgs } from './antigravityMcpLaunch.js';
import { vibeToolPolicyArgs } from './vibeMcpLaunch.js';
import { openCodeToolPolicyArgs } from './openCodeMcpLaunch.js';
import type { McpLaunchBuilder } from './mcpLaunchContract.js';

export * from './mcpLaunchContract.js';
export { CLAUDE_WEB_TOOLS, claudeToolPolicyArgs } from './claudeMcpLaunch.js';
export { codexToolPolicyArgs } from './codexMcpLaunch.js';
export { ANTIGRAVITY_MCP_CONFIG_ENV, ANTIGRAVITY_SKILLS_ENV, antigravityMcpConfigTemplate, antigravitySkillsSpec, antigravityToolPolicyArgs, antigravityToolPolicyEnvironment } from './antigravityMcpLaunch.js';
export { VIBE_MCP_SERVERS_ENV, vibeToolPolicyArgs } from './vibeMcpLaunch.js';
export { OPENCODE_EXCLUSIVE_CONFIG_ENV, mergeOpenCodeConfigContent, openCodeMcpConfig, openCodeToolPolicyArgs, openCodeToolPolicyEnvironment } from './openCodeMcpLaunch.js';

/**
 * One MCP launch builder per agent type. A runtime enabled in the capability
 * map (`AGENT_RUNTIME_CAPABILITIES`) for extensions or ProPR MCP must have one.
 */
export const MCP_LAUNCH_BUILDERS: Readonly<Partial<Record<AgentType, McpLaunchBuilder>>> = {
    claude: claudeToolPolicyArgs,
    codex: codexToolPolicyArgs,
    antigravity: antigravityToolPolicyArgs,
    vibe: vibeToolPolicyArgs,
    opencode: openCodeToolPolicyArgs,
};

export const mcpLaunchBuilder = (agentType: string): McpLaunchBuilder | undefined => (Object.hasOwn(MCP_LAUNCH_BUILDERS, agentType) ? MCP_LAUNCH_BUILDERS[agentType as AgentType] : undefined);
