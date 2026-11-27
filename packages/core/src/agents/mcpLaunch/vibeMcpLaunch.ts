import type { AgentToolPolicy } from '../types.js';
import { EXTENSION_SKILLS_ROOT, EXTENSION_STDIO_BRIDGE, EXTENSION_STDIO_NODE, validatedMcpServers, type ToolPolicyLaunchArgs } from './mcpLaunchContract.js';

/** Vibe's environment layer (`VIBE_` prefix) for the run's MCP catalog. */
export const VIBE_MCP_SERVERS_ENV = 'VIBE_MCP_SERVERS';

/**
 * Vibe 3: no CLI switches. Everything is rendered through Vibe's environment
 * layer, which the launcher passes as `-e NAME` with the value supplied through
 * the docker process environment:
 *
 * - `VIBE_MCP_SERVERS`: a JSON list. Stdio servers do not inherit the agent
 *   environment (Vibe hands `server.env` to the MCP SDK, whose default
 *   environment is minimal), so each stdio entry carries the bridge's secret
 *   names and values in its own `env`. HTTP servers read their bearer token
 *   from `api_key_env`.
 * - `VIBE_SKILL_PATHS`: the staged skill bundle root, so Vibe's native `skill`
 *   tool finds the run's bundles. With `exclusiveMcp`, `VIBE_ENABLED_SKILLS`
 *   limits active skills to the run's bundle names.
 * - With `exclusiveMcp`, `PROPR_EXTENSION_EXCLUSIVE_MCP=1` tells the entrypoint
 *   to strip `mcp_servers` from the runtime copy of `config.toml` (Vibe
 *   union-merges them by name) and to turn Mistral cloud connectors off.
 *
 * Vibe has no native web switch; the web restriction stays prompt-only.
 */
export function vibeToolPolicyArgs(policy: AgentToolPolicy): ToolPolicyLaunchArgs {
    const servers = validatedMcpServers(policy);
    const local = policy.localMcpServers ?? [];
    const entries = [
        ...local.map(server => ({ name: server.name, transport: 'stdio', command: EXTENSION_STDIO_NODE, args: [EXTENSION_STDIO_BRIDGE, server.bridgeConfig], env: { ...server.env } })),
        ...servers.map(server => ({ name: server.name, transport: 'streamable-http', url: server.url, auth: { type: 'static', api_key_env: server.bearerTokenEnv } })),
    ];
    const env: Record<string, string> = Object.fromEntries(servers.map(server => [server.bearerTokenEnv, server.bearerToken]));
    if (entries.length || policy.exclusiveMcp) env[VIBE_MCP_SERVERS_ENV] = JSON.stringify(entries);
    const skills = policy.skillNames ?? [];
    if (skills.length) env.VIBE_SKILL_PATHS = JSON.stringify([EXTENSION_SKILLS_ROOT]);
    if (policy.exclusiveMcp) {
        env.PROPR_EXTENSION_EXCLUSIVE_MCP = '1';
        env.VIBE_ENABLE_CONNECTORS = 'false';
        if (skills.length) env.VIBE_ENABLED_SKILLS = JSON.stringify(skills);
    }
    // Stdio secret values are inside VIBE_MCP_SERVERS: keep them out of
    // accidental serialization of the result, as the shared contract does.
    const cliArgs: string[] = [];
    return local.length ? Object.defineProperty({ cliArgs } as ToolPolicyLaunchArgs, 'env', { value: env, enumerable: false }) : { cliArgs, env };
}
