import type { AgentToolPolicy } from '../types.js';
import { EXTENSION_SKILLS_ROOT, EXTENSION_STDIO_BRIDGE, EXTENSION_STDIO_NODE, mcpLaunchArgs, validatedMcpServers, type ToolPolicyLaunchArgs } from './mcpLaunchContract.js';

export interface PiToolPolicyLaunchArgs extends ToolPolicyLaunchArgs {
    /**
     * `mcp.json` for the disposable Pi agent dir (pi-entrypoint.sh writes it
     * from `PROPR_PI_MCP_CONFIG`), or undefined when the run has no servers.
     * It names token variables only; Pi expands `${VAR}` from its environment.
     */
    mcpConfig?: string;
}

/**
 * Pi: a ProPR-generated `mcp.json` (never the host's or the repository's) and
 * one `--skill` per staged bundle. Stdio bridges inherit Pi's environment, so
 * their secrets only need `-e NAME`. An exclusive policy also drops every
 * discovered or configured skill; `--no-approve`, always set for Pi, keeps a
 * project `.pi/mcp.json` and project skills out. Pi has no web tool of its
 * own, so the web restriction stays a prompt notice.
 */
export function piToolPolicyArgs(policy: AgentToolPolicy): PiToolPolicyLaunchArgs {
    const servers = validatedMcpServers(policy);
    const cliArgs: string[] = [];
    if (policy.exclusiveMcp) cliArgs.push('--no-skills');
    for (const skill of policy.skills ?? []) cliArgs.push('--skill', `${EXTENSION_SKILLS_ROOT}/${skill.id}`);
    const launch: PiToolPolicyLaunchArgs = mcpLaunchArgs(policy, cliArgs, servers);
    if (servers.length > 0 || policy.localMcpServers?.length) {
        launch.mcpConfig = JSON.stringify({
            mcpServers: {
                ...Object.fromEntries((policy.localMcpServers ?? []).map(s => [s.name, { command: EXTENSION_STDIO_NODE, args: [EXTENSION_STDIO_BRIDGE, s.bridgeConfig] }])),
                ...Object.fromEntries(servers.map(server => [server.name, { url: server.url, headers: { Authorization: `Bearer \${${server.bearerTokenEnv}}` } }])),
            },
        });
    }
    return launch;
}
