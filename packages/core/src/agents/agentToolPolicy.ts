import type { AgentToolPolicy } from './types.js';

/**
 * Pure builders that turn a per-run {@link AgentToolPolicy} into native CLI
 * switches. MCP bearer tokens only ever appear in the returned `env` map: the
 * launcher passes them to the container as `-e NAME` with the value supplied
 * through the docker process environment, so they never show up in `ps` or in
 * logged arguments, and nothing is written to the worktree.
 */

/** Fixed MCP server name so prompts can refer to "the `propr` MCP server". */
export const PROPR_MCP_SERVER_NAME = 'propr';
/** Container environment variable carrying the run-scoped ProPR MCP credential. */
export const PROPR_MCP_BEARER_TOKEN_ENV = 'PROPR_MCP_BEARER_TOKEN';

export const CLAUDE_WEB_TOOLS = ['WebFetch', 'WebSearch'] as const;

export interface ToolPolicyLaunchArgs {
    cliArgs: string[];
    env: Record<string, string>;
}

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function mcpServers(policy: AgentToolPolicy): NonNullable<AgentToolPolicy['mcpServers']> {
    const servers = policy.mcpServers ?? [];
    for (const server of servers) {
        if (!SERVER_NAME_PATTERN.test(server.name)) throw new Error(`Invalid MCP server name: ${server.name}`);
        if (!ENV_NAME_PATTERN.test(server.bearerTokenEnv)) throw new Error(`Invalid MCP bearer token environment variable: ${server.bearerTokenEnv}`);
    }
    return servers;
}

function tokenEnv(servers: NonNullable<AgentToolPolicy['mcpServers']>): Record<string, string> {
    return Object.fromEntries(servers.map(server => [server.bearerTokenEnv, server.bearerToken]));
}

/** Claude Code: `--disallowedTools` for web, inline `--mcp-config` with env-expanded auth. */
export function claudeToolPolicyArgs(policy: AgentToolPolicy): ToolPolicyLaunchArgs {
    const servers = mcpServers(policy);
    const cliArgs: string[] = [];
    if (!policy.allowWeb) cliArgs.push('--disallowedTools', ...CLAUDE_WEB_TOOLS);
    if (servers.length > 0) {
        const config = {
            mcpServers: Object.fromEntries(servers.map(server => [server.name, {
                type: 'http',
                url: server.url,
                // Claude Code expands `${VAR}` from its own environment.
                headers: { Authorization: `Bearer \${${server.bearerTokenEnv}}` },
            }])),
        };
        cliArgs.push('--mcp-config', JSON.stringify(config));
    }
    return { cliArgs, env: tokenEnv(servers) };
}

/** Codex: `-c tools.web_search=false` and `mcp_servers.<name>.*` reading the token from the environment. */
export function codexToolPolicyArgs(policy: AgentToolPolicy): ToolPolicyLaunchArgs {
    const servers = mcpServers(policy);
    const cliArgs: string[] = [];
    if (!policy.allowWeb) cliArgs.push('-c', 'tools.web_search=false');
    for (const server of servers) {
        cliArgs.push(
            '-c', `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`,
            '-c', `mcp_servers.${server.name}.bearer_token_env_var=${JSON.stringify(server.bearerTokenEnv)}`,
        );
    }
    return { cliArgs, env: tokenEnv(servers) };
}

/**
 * Runtimes without a native switch (Antigravity, OpenCode, Vibe) get the web
 * restriction as a prompt notice only: best effort, not enforcement. Returns
 * an empty string when nothing needs saying.
 */
export function promptOnlyToolPolicyNotice(policy: AgentToolPolicy | undefined): string {
    if (!policy || policy.allowWeb) return '';
    return 'Tool policy for this run: web access is not allowed. Do not browse, fetch URLs or search the web, and do not claim to have looked anything up online.';
}

/** Appends the prompt-only notice to a prompt when the policy requires one. */
export function withPromptOnlyToolPolicy(prompt: string, policy: AgentToolPolicy | undefined): string;
export function withPromptOnlyToolPolicy(prompt: string | undefined, policy: AgentToolPolicy | undefined): string | undefined;
export function withPromptOnlyToolPolicy(prompt: string | undefined, policy: AgentToolPolicy | undefined): string | undefined {
    const notice = promptOnlyToolPolicyNotice(policy);
    if (!notice) return prompt;
    return prompt ? `${prompt}\n\n${notice}` : notice;
}
