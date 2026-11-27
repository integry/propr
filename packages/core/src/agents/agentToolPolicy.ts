import type { AgentTaskOptions, AgentToolPolicy } from './types.js';

/**
 * Run tool policy helpers. The per-agent builders that turn a policy into
 * native CLI switches, and their shared contract, are in `./mcpLaunch`.
 */

/** Fixed MCP server name so prompts can refer to "the `propr` MCP server". */
export const PROPR_MCP_SERVER_NAME = 'propr';
/** Container environment variable carrying the run-scoped ProPR MCP credential. */
export const PROPR_MCP_BEARER_TOKEN_ENV = 'PROPR_MCP_BEARER_TOKEN';

// Per-runtime MCP rendering lives in one builder per agent type (`./mcpLaunch`);
// these re-exports keep the existing import paths.
export { CLAUDE_WEB_TOOLS, antigravityToolPolicyArgs, claudeToolPolicyArgs, codexToolPolicyArgs, mcpLaunchBuilder, MCP_LAUNCH_BUILDERS, type McpLaunchBuilder, type ToolPolicyLaunchArgs } from './mcpLaunch/index.js';

/**
 * Tool policies are only applied to task execution. Goal mode launches through
 * separate builders that do not apply them, so a goal run would silently drop
 * the restriction: refuse it instead.
 */
export function assertToolPolicySupported(options: Pick<AgentTaskOptions, 'executionMode' | 'toolPolicy'>): void {
    if (options.executionMode === 'goal' && options.toolPolicy) {
        throw new Error('A tool policy is only supported for task execution, not goal mode');
    }
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
