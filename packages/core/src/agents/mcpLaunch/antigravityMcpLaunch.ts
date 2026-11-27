import type { AgentToolPolicy } from '../types.js';
import { EXTENSION_STDIO_BRIDGE, EXTENSION_STDIO_NODE, mcpLaunchArgs, validatedMcpServers, type ToolPolicyLaunchArgs } from './mcpLaunchContract.js';

/** Container environment variable carrying the run's Antigravity MCP config template. */
export const ANTIGRAVITY_MCP_CONFIG_ENV = 'PROPR_ANTIGRAVITY_MCP_CONFIG';
/** Container environment variable naming the staged skill bundles as `<id>:<name>` pairs. */
export const ANTIGRAVITY_SKILLS_ENV = 'PROPR_ANTIGRAVITY_SKILLS';

const SKILL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The `mcp_config.json` template for one run, without any token value. agy
 * reads `<HOME>/.gemini/config/mcp_config.json` and does not expand `${VAR}`
 * in headers, so a remote server names its token variable in `bearerTokenEnv`
 * and the entrypoint writes the real header into the container-only file:
 *
 * ```json
 * {"mcpServers":{
 *   "<local>":{"command":"/usr/local/bin/node","args":["/opt/propr/extension-stdio-bridge.mjs","<bridgeConfig>"]},
 *   "<url>":{"serverUrl":"<gateway>/api/extensions/mcp/<name>","bearerTokenEnv":"PROPR_EXTENSION_MCP_0_TOKEN"}}}
 * ```
 *
 * Stdio servers inherit the agent environment, so their secrets only need `-e`.
 */
export function antigravityMcpConfigTemplate(policy: AgentToolPolicy): string | undefined {
    const servers = validatedMcpServers(policy);
    const local = policy.localMcpServers ?? [];
    if (!servers.length && !local.length && !policy.exclusiveMcp) return undefined;
    return JSON.stringify({
        mcpServers: {
            ...Object.fromEntries(local.map(s => [s.name, { command: EXTENSION_STDIO_NODE, args: [EXTENSION_STDIO_BRIDGE, s.bridgeConfig] }])),
            ...Object.fromEntries(servers.map(server => [server.name, { serverUrl: server.url, bearerTokenEnv: server.bearerTokenEnv }])),
        },
    });
}

/** `<id>:<name>` pairs of the run's staged skill bundles, or undefined without any. */
export function antigravitySkillsSpec(policy: AgentToolPolicy): string | undefined {
    const skills = policy.skills ?? [];
    for (const skill of skills) {
        if (!SKILL_ID_PATTERN.test(skill.id) || !SKILL_NAME_PATTERN.test(skill.name)) throw new Error(`Invalid skill bundle for Antigravity: ${skill.id}`);
    }
    return skills.length ? skills.map(skill => `${skill.id}:${skill.name}`).join(' ') : undefined;
}

/**
 * Antigravity: no CLI switches. The config template, the exclusive switch and
 * the skill list travel as container environment; tokens and stdio secrets
 * are only in the returned `env` map, passed by name.
 */
export function antigravityToolPolicyArgs(policy: AgentToolPolicy): ToolPolicyLaunchArgs {
    return mcpLaunchArgs(policy, [], validatedMcpServers(policy));
}

/** Non-secret container environment for the Antigravity entrypoint. */
export function antigravityToolPolicyEnvironment(policy: AgentToolPolicy): string[] {
    const template = antigravityMcpConfigTemplate(policy);
    const skills = antigravitySkillsSpec(policy);
    return [
        ...(template ? ['-e', `${ANTIGRAVITY_MCP_CONFIG_ENV}=${template}`] : []),
        ...(policy.exclusiveMcp ? ['-e', 'PROPR_EXTENSION_EXCLUSIVE_MCP=1'] : []),
        ...(skills ? ['-e', `${ANTIGRAVITY_SKILLS_ENV}=${skills}`] : []),
    ];
}
