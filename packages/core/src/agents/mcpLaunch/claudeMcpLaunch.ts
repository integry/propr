import type { AgentToolPolicy } from '../types.js';
import { EXTENSION_STDIO_BRIDGE, EXTENSION_STDIO_NODE, mcpLaunchArgs, validatedMcpServers, type ToolPolicyLaunchArgs } from './mcpLaunchContract.js';

export const CLAUDE_WEB_TOOLS = ['WebFetch', 'WebSearch'] as const;

/** Claude Code: `--disallowedTools` for web, inline `--mcp-config` with env-expanded auth. */
export function claudeToolPolicyArgs(policy: AgentToolPolicy): ToolPolicyLaunchArgs {
    const servers = validatedMcpServers(policy);
    const cliArgs: string[] = [];
    if (!policy.allowWeb) cliArgs.push('--disallowedTools', ...CLAUDE_WEB_TOOLS);
    if (policy.exclusiveMcp) cliArgs.push('--strict-mcp-config');
    if (servers.length > 0 || policy.localMcpServers?.length || policy.exclusiveMcp) {
        const config = {
            mcpServers: { ...Object.fromEntries((policy.localMcpServers ?? []).map(s => [s.name, { type: 'stdio', command: EXTENSION_STDIO_NODE, args: [EXTENSION_STDIO_BRIDGE, s.bridgeConfig] }])), ...Object.fromEntries(servers.map(server => [server.name, {
                type: 'http',
                url: server.url,
                // Claude Code expands `${VAR}` from its own environment.
                headers: { Authorization: `Bearer \${${server.bearerTokenEnv}}` },
            }])) },
        };
        cliArgs.push('--mcp-config', JSON.stringify(config));
    }
    return mcpLaunchArgs(policy, cliArgs, servers);
}
