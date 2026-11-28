import type { AgentToolPolicy } from '../types.js';
import { EXTENSION_SKILLS_ROOT, EXTENSION_STDIO_BRIDGE, EXTENSION_STDIO_NODE, mcpLaunchArgs, validatedMcpServers, type ToolPolicyLaunchArgs } from './mcpLaunchContract.js';

/** Tells the entrypoint to build a disposable config dir without the host's MCP servers and skills. */
export const OPENCODE_EXCLUSIVE_CONFIG_ENV = 'PROPR_OPENCODE_EXCLUSIVE_CONFIG';

type OpenCodeConfig = Record<string, unknown>;

/**
 * The run's part of the OpenCode 2.x inline config (`OPENCODE_CONFIG_CONTENT`),
 * or undefined when the run has no servers or skills. 2.x reads servers from
 * `mcp.servers`; a flat 1.x-style `mcp.<name>` block is ignored.
 *
 * ```json
 * {"mcp":{"servers":{
 *   "<local>":{"type":"local","command":["/usr/local/bin/node","/opt/propr/extension-stdio-bridge.mjs","<bridgeConfig>"]},
 *   "<url>":{"type":"remote","url":"<gateway>/api/extensions/mcp/<name>","headers":{"Authorization":"Bearer {env:PROPR_EXTENSION_MCP_0_TOKEN}"}}
 * }},
 * "skills":{"paths":["/opt/propr/extensions"]}}
 * ```
 *
 * Local servers inherit the container environment, so the bridge secrets only
 * need `-e NAME`. OpenCode substitutes `{env:VAR}` in the header, so no token
 * value is ever written into the config.
 */
export function openCodeMcpConfig(policy: AgentToolPolicy): OpenCodeConfig | undefined {
    const servers = validatedMcpServers(policy);
    const local = policy.localMcpServers ?? [];
    const skills = policy.skills ?? [];
    if (!servers.length && !local.length && !skills.length) return undefined;
    const config: OpenCodeConfig = {};
    if (servers.length || local.length) {
        config.mcp = {
            servers: {
                ...Object.fromEntries(local.map(s => [s.name, { type: 'local', command: [EXTENSION_STDIO_NODE, EXTENSION_STDIO_BRIDGE, s.bridgeConfig] }])),
                ...Object.fromEntries(servers.map(server => [server.name, {
                    type: 'remote',
                    url: server.url,
                    headers: { Authorization: `Bearer {env:${server.bearerTokenEnv}}` },
                }])),
            },
        };
    }
    // Staged `<id>/SKILL.md` bundles load natively; OpenCode uses the folder name as the skill id.
    if (skills.length) config.skills = { paths: [EXTENSION_SKILLS_ROOT] };
    return config;
}

const isPlainObject = (value: unknown): value is OpenCodeConfig => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Deep-merges the run's config into existing inline config content. Objects
 * merge key by key (so existing `mcp.servers` keep their entries); skill paths
 * are concatenated without duplicates; anything else takes the run's value.
 */
export function mergeOpenCodeConfigContent(existing: string | undefined, addition: OpenCodeConfig | undefined): string | undefined {
    if (!addition) return existing;
    const base: unknown = existing ? JSON.parse(existing) : {};
    if (!isPlainObject(base)) throw new Error('OpenCode inline config must be a JSON object');
    return JSON.stringify(mergeConfig(base, addition));
}

function mergeConfig(base: OpenCodeConfig, addition: OpenCodeConfig): OpenCodeConfig {
    const merged: OpenCodeConfig = { ...base };
    for (const [key, value] of Object.entries(addition)) {
        const current = merged[key];
        if (isPlainObject(current) && isPlainObject(value)) merged[key] = mergeConfig(current, value);
        else if (key === 'paths' && Array.isArray(current) && Array.isArray(value)) merged[key] = [...new Set([...current, ...value])];
        else merged[key] = value;
    }
    return merged;
}

/**
 * Non-secret container environment for an OpenCode run under `policy`. With
 * `exclusiveMcp` no ambient servers or skills load:
 *
 * - `OPENCODE_CONFIG_PROJECT_DISABLE=1`: no workspace `opencode.json`,
 *   `.opencode/`, `.claude/` or `.agents/` folders.
 * - `OPENCODE_DISABLE_CLAUDE_CODE=1`: no `~/.claude` skills or prompt.
 * - `OPENCODE_CONFIG=` (empty): no operator-set explicit config file.
 * - The entrypoint points `OPENCODE_CONFIG_DIR` at a disposable copy of the
 *   host config dir with `mcp` and `skills` removed from its config documents
 *   and its `skills/` folders left out. 2.4.2 deep-merges config sources, so an
 *   inline `"mcp":{"servers":{}}` does not remove host servers; replacing the
 *   config dir does, while the host's providers and other settings still apply.
 */
export function openCodeToolPolicyEnvironment(policy: AgentToolPolicy): string[] {
    if (!policy.exclusiveMcp) return [];
    return [
        '-e', 'OPENCODE_CONFIG_PROJECT_DISABLE=1',
        '-e', 'OPENCODE_DISABLE_CLAUDE_CODE=1',
        '-e', 'OPENCODE_CONFIG=',
        '-e', `${OPENCODE_EXCLUSIVE_CONFIG_ENV}=1`,
    ];
}

/**
 * OpenCode 2.x: no CLI switches. The servers and skill path travel in the
 * inline config (see {@link openCodeMcpConfig}); the returned `env` carries the
 * bearer tokens and stdio secrets, passed to the container by name only.
 * OpenCode has no native web switch; the web restriction stays prompt-only.
 */
export function openCodeToolPolicyArgs(policy: AgentToolPolicy): ToolPolicyLaunchArgs {
    return mcpLaunchArgs(policy, [], validatedMcpServers(policy));
}
