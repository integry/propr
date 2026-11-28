import type { AgentToolPolicy } from '../types.js';
import { EXTENSION_STDIO_BRIDGE, EXTENSION_STDIO_NODE, mcpLaunchArgs, validatedMcpServers, type ToolPolicyLaunchArgs } from './mcpLaunchContract.js';

/**
 * Codex: `-c web_search="disabled"` and `mcp_servers.<name>.*` reading the token
 * from the environment. The pinned Codex CLI ignores the legacy
 * `tools.web_search=false` and still offers the `web_search` tool.
 */
export function codexToolPolicyArgs(policy: AgentToolPolicy): ToolPolicyLaunchArgs {
    const servers = validatedMcpServers(policy);
    const cliArgs: string[] = [];
    if (!policy.allowWeb) cliArgs.push('-c', 'web_search="disabled"');
    if (policy.exclusiveMcp) {
        const catalog = [...(policy.localMcpServers ?? []).map(s => `${s.name}={command=${JSON.stringify(EXTENSION_STDIO_NODE)},args=[${JSON.stringify(EXTENSION_STDIO_BRIDGE)},${JSON.stringify(s.bridgeConfig)}],env_vars=${JSON.stringify(Object.keys(s.env))}}`), ...servers.map(server => `${server.name}={url=${JSON.stringify(server.url)},bearer_token_env_var=${JSON.stringify(server.bearerTokenEnv)}}`)].join(',');
        // The pinned runtime merges table overrides with its user catalog.
        // Ignore that catalog while retaining auth custody in CODEX_HOME.
        cliArgs.push('--ignore-user-config', '-c', `mcp_servers={${catalog}}`);
    } else for (const server of servers) {
        cliArgs.push(
            '-c', `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`,
            '-c', `mcp_servers.${server.name}.bearer_token_env_var=${JSON.stringify(server.bearerTokenEnv)}`,
        );
    }
    return mcpLaunchArgs(policy, cliArgs, servers);
}
