import type { AgentToolPolicy, AgentToolPolicyMcpServer } from '../types.js';

/**
 * The shared contract every per-agent MCP launch builder renders. A run's
 * {@link AgentToolPolicy} carries three things the builder turns into native
 * CLI switches:
 *
 * - `mcpServers`: remote servers. Extension servers are reached through the
 *   Core gateway at `<gateway>/api/extensions/mcp/<name>` with a run-scoped
 *   bearer token in `PROPR_EXTENSION_MCP_<i>_TOKEN`.
 * - `localMcpServers`: stdio servers run in the task container as
 *   `node /opt/propr/extension-stdio-bridge.mjs <base64 cfg>`, their secrets
 *   passed only as `PROPR_EXTENSION_STDIO_*` environment names.
 * - `exclusiveMcp`: no ambient servers or skills from the runtime's own
 *   configuration; only the run's servers.
 * - `skills`: the run's skill bundles (id and name), staged at
 *   {@link EXTENSION_SKILLS_ROOT}, for runtimes with native skills.
 *
 * Tokens and secret values only ever appear in the returned `env` map: the
 * launcher passes them to the container as `-e NAME` with the value supplied
 * through the docker process environment, so they never show up in `ps` or in
 * logged arguments, and nothing is written to the worktree.
 */
export interface ToolPolicyLaunchArgs {
    cliArgs: string[];
    env: Record<string, string>;
}
export type McpLaunchBuilder = (policy: AgentToolPolicy) => ToolPolicyLaunchArgs;

/** Container path of the stdio bridge and the node binary that runs it. */
export const EXTENSION_STDIO_NODE = '/usr/local/bin/node';
export const EXTENSION_STDIO_BRIDGE = '/opt/propr/extension-stdio-bridge.mjs';
/** Read-only container root of the run's staged skill bundles (`<root>/<bundle id>/SKILL.md`). */
export const EXTENSION_SKILLS_ROOT = '/opt/propr/extensions';
/** Gateway URL of one extension server, from the gateway base (`…/api/extensions/mcp`). */
export const extensionMcpServerUrl = (gatewayBase: string, name: string) => `${gatewayBase}/${name}`;
/** Bearer environment variable of the `index`-th gateway server of a run. */
export const extensionMcpTokenEnv = (index: number) => `PROPR_EXTENSION_MCP_${index}_TOKEN`;
/** Environment variable carrying the `secret`-th secret of the `index`-th stdio server. */
export const extensionStdioSecretEnv = (index: number, secret: number) => `PROPR_EXTENSION_STDIO_${index}_${secret}_SECRET`;

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The policy's remote servers, after validating names that reach CLI arguments. */
export function validatedMcpServers(policy: AgentToolPolicy): AgentToolPolicyMcpServer[] {
    const servers = policy.mcpServers ?? [];
    for (const server of servers) {
        if (!SERVER_NAME_PATTERN.test(server.name)) throw new Error(`Invalid MCP server name: ${server.name}`);
        if (!ENV_NAME_PATTERN.test(server.bearerTokenEnv)) throw new Error(`Invalid MCP bearer token environment variable: ${server.bearerTokenEnv}`);
    }
    return servers;
}

/** The builder result: CLI switches plus the token and stdio secret environment. */
export function mcpLaunchArgs(policy: AgentToolPolicy, cliArgs: string[], servers: AgentToolPolicyMcpServer[]): ToolPolicyLaunchArgs {
    const env = { ...Object.fromEntries(servers.map(server => [server.bearerTokenEnv, server.bearerToken])), ...Object.assign({}, ...(policy.localMcpServers ?? []).map(s => s.env)) };
    // Operator secret values remain usable by the process launcher while being
    // absent from accidental argument/config JSON serialization.
    return policy.localMcpServers?.length ? Object.defineProperty({ cliArgs } as ToolPolicyLaunchArgs, 'env', { value: env, enumerable: false }) : { cliArgs, env };
}
