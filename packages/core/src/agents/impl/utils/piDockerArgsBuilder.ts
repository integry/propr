import fs from 'fs';
import type { AgentConfig, AgentToolPolicy } from '../../types.js';
import { CONTAINER_CONFIG_PATHS } from '../../types.js';
import type { PiThinkingLevel } from '../../../config/configManagerReasoning.js';
import { buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../agentGitAccess.js';
import { agentContainerNetwork } from '../../agentContainerNetwork.js';
import { piToolPolicyArgs } from '../../agentToolPolicy.js';
import { buildAgentContainerResourceArgs, wrapDockerRunArgsWithRepoSetup } from '../../../claude/docker/repoSetupWrapper.js';
import { openCodeEnvVarRejection } from '../openCodeEnvForwarding.js';
import { toPiCliModel } from '../piModelIds.js';
import { createContainerExecutionId } from './containerExecutionId.js';
import { buildPiRepositoryScoutArgs, buildPiRepositoryScoutConfig, REPOSITORY_SCOUT_CONTAINER_ROOT } from './repositoryScoutMcpServer.js';

/** Where the host Pi agent dir is mounted; pi-entrypoint.sh's PROPR_PI_SOURCE_DIR default. */
export const PI_CONTAINER_SOURCE_DIR = CONTAINER_CONFIG_PATHS.pi;
/**
 * The disposable Pi home pi-entrypoint.sh creates fresh for each run and
 * chowns to node; nothing is bind-mounted under it, so no path in it is ever
 * root-owned.
 */
export const PI_CONTAINER_RUNTIME_HOME = '/tmp/propr-pi-home';
export const PI_CONTAINER_SESSION_DIR = `${PI_CONTAINER_RUNTIME_HOME}/agent/sessions`;
const WORKSPACE = '/home/node/workspace';
/** pi-entrypoint.sh writes this variable's value to `<PI_CODING_AGENT_DIR>/mcp.json`. */
export const PI_MCP_CONFIG_ENV = 'PROPR_PI_MCP_CONFIG';

/** Variables pi-entrypoint.sh and ProPR own; a configured value would break the run's isolation. */
const RESERVED_PI_ENV_NAMES = new Set([
    'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PROPR_PI_SOURCE_DIR', 'PROPR_PI_RUNTIME_HOME',
    'PROPR_PI_CREDENTIALS_HELPER', 'PROPR_PI_MCP_CONFIG', 'PROPR_AGENT_TYPE', 'HOME', 'USER', 'PATH',
]);

export interface PiDockerArgsParams {
    config: AgentConfig;
    worktreePath: string;
    /** Resolved host Pi agent dir; mounted only when it exists. */
    configPath?: string;
    modelName: string;
    thinkingLevel?: PiThinkingLevel | null;
    issueNumber: number;
    taskId?: string;
    executionType?: string;
    mode?: 'execute' | 'analysis';
    gitMountArgs?: string[];
    /**
     * Analysis only: the read-only repository scout. Every built-in tool is
     * off and the ProPR repository MCP server is the only tool surface.
     */
    repositoryInspection?: boolean;
    /** Task runs only: the run's MCP servers and skills (ProPR MCP, extension library). */
    toolPolicy?: AgentToolPolicy;
}

export interface PiDockerInvocation {
    args: string[];
    /**
     * Secret values the container reads through `-e NAME`, passed in the docker
     * client's environment so they never appear in its argument list.
     */
    secretEnv: Record<string, string>;
    /**
     * Non-secret values too large or too structured for argv (the generated
     * `mcp.json`), passed the same way. It names token variables, never values.
     */
    configEnv: Record<string, string>;
}

/** The agent's configured env vars that may reach Pi (provider API keys and the like). */
export function forwardablePiEnvVars(envVars: Record<string, string> | undefined): Record<string, string> {
    const forwarded: Record<string, string> = {};
    for (const [key, value] of Object.entries(envVars ?? {})) {
        if (typeof value !== 'string' || openCodeEnvVarRejection(key, value) || RESERVED_PI_ENV_NAMES.has(key) || key.startsWith('PROPR_')) continue;
        forwarded[key] = value;
    }
    return forwarded;
}

/**
 * `pi -p --mode json` arguments after the image; the prompt arrives on stdin,
 * which is always closed after it (an open stdin makes `pi -p` wait forever).
 *
 * Tools mirror the other runtimes' analysis policy: an analysis is tool-less
 * (`--no-tools` also drops MCP and the codemode runner), as Claude disables
 * its native file tools on a read-only workspace. The scout alone gets tools,
 * and only the repository MCP server's.
 */
export function buildPiCliArgs(params: { modelName: string; thinkingLevel?: PiThinkingLevel | null; mode: 'execute' | 'analysis'; repositoryInspection?: boolean; toolPolicyArgs?: string[] }): string[] {
    if (params.repositoryInspection && params.mode !== 'analysis') throw new Error('Repository inspection requires analysis mode');
    const { model, thinking } = toPiCliModel(params.modelName);
    const effectiveThinking = params.thinkingLevel ?? thinking;
    const args = ['pi', '-p', '--mode', 'json', '--model', thinking ? `${model}:${thinking}` : model];
    if (effectiveThinking) args.push('--thinking', effectiveThinking);
    if (params.mode === 'analysis') {
        // Lightweight analysis keeps nothing and runs no tool that can write.
        args.push('--no-session');
        if (params.repositoryInspection) return [...args, ...buildPiRepositoryScoutArgs()];
        args.push('--no-tools');
    } else {
        args.push('--session-dir', PI_CONTAINER_SESSION_DIR, ...(params.toolPolicyArgs ?? []));
    }
    // Never trust repository-provided .pi/ extensions, settings, MCP servers or
    // prompts. AGENTS.md / CLAUDE.md context files still load.
    args.push('--no-approve');
    return args;
}

function buildPiContainerName(alias: string, taskType: string, taskId: string | undefined, modelName: string): string {
    const suffix = `-${createContainerExecutionId(taskId)}`;
    const prefix = `${alias || 'pi'}-${taskType}-${modelName}`
        .replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 120 - suffix.length).replace(/[^a-zA-Z0-9]+$/, '');
    return `${prefix || 'pi'}${suffix}`.slice(0, 128);
}

/**
 * What reaches the container through the docker client's environment:
 * provider keys, the GitHub token (never for the credential-free scout), the
 * run's MCP tokens and stdio bridge secrets (stdio servers inherit Pi's
 * environment), and the generated `mcp.json`.
 */
function buildPiContainerEnv(params: { config: AgentConfig; githubToken: string; repositoryInspection: boolean; toolPolicy?: AgentToolPolicy }): { secretEnv: Record<string, string>; configEnv: Record<string, string>; cliArgs?: string[] } {
    const policy = params.toolPolicy ? piToolPolicyArgs(params.toolPolicy) : undefined;
    const secretEnv: Record<string, string> = { ...forwardablePiEnvVars(params.config.envVars) };
    if (params.githubToken && !params.repositoryInspection) Object.assign(secretEnv, { GH_TOKEN: params.githubToken, GITHUB_TOKEN: params.githubToken });
    if (policy) Object.assign(secretEnv, policy.env);
    const mcpConfig = params.repositoryInspection ? buildPiRepositoryScoutConfig() : policy?.mcpConfig;
    return { secretEnv, configEnv: mcpConfig ? { [PI_MCP_CONFIG_ENV]: mcpConfig } : {}, cliArgs: policy?.cliArgs };
}

/**
 * `docker run` arguments for one Pi run. The container starts as root only so
 * pi-entrypoint.sh can seed and chown the disposable Pi home; every Pi process
 * runs as node.
 */
export function buildPiDockerArgs(params: PiDockerArgsParams, githubToken: string): PiDockerInvocation {
    const { config, worktreePath, configPath, modelName, thinkingLevel, issueNumber, taskId, executionType, mode = 'execute', repositoryInspection = false } = params;
    const analysis = mode === 'analysis';
    if (repositoryInspection && !analysis) throw new Error('Repository inspection requires analysis mode');
    // Tool policies (MCP servers, extension items) only apply to task runs.
    const toolPolicy = analysis ? undefined : params.toolPolicy;
    const { secretEnv, configEnv, cliArgs: toolPolicyArgs } = buildPiContainerEnv({ config, githubToken, repositoryInspection, toolPolicy });
    const workspaceMode = analysis ? 'ro' : 'rw';
    // A missing host dir is not mounted: Docker would create it, root-owned, on the host.
    // The mount is writable so refreshed OAuth tokens can be written back (pi-credentials.py).
    const configMountArgs = configPath && fs.existsSync(configPath) ? ['-v', `${configPath}:${PI_CONTAINER_SOURCE_DIR}:rw`] : [];
    const containerName = buildPiContainerName(config.alias, executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`), taskId, modelName);
    const dockerArgs = [
        'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--network', agentContainerNetwork(toolPolicy), '--user', '0:0',
        // The scout sees the repository only through its MCP server's root, never the working directory.
        '-v', `${worktreePath}:${repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : WORKSPACE}:${workspaceMode}`,
        ...(repositoryInspection ? [] : params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, false, analysis)),
        ...configMountArgs,
        '-e', 'PROPR_AGENT_TYPE=pi',
        '-e', `PROPR_PI_SOURCE_DIR=${PI_CONTAINER_SOURCE_DIR}`,
        '-e', `PROPR_PI_RUNTIME_HOME=${PI_CONTAINER_RUNTIME_HOME}`,
        ...(analysis ? ['-e', 'PROPR_REPO_SETUP=0'] : []),
        ...Object.keys(secretEnv).flatMap(name => ['-e', name]),
        ...Object.keys(configEnv).flatMap(name => ['-e', name]),
        ...buildAgentGitCredentialArgs(),
        '-w', WORKSPACE, config.dockerImage,
        ...buildPiCliArgs({ modelName, thinkingLevel, mode, repositoryInspection, toolPolicyArgs }),
    ];
    if (analysis) return { args: [dockerArgs[0], ...buildAgentContainerResourceArgs(), ...dockerArgs.slice(1)], secretEnv, configEnv };
    return { args: wrapDockerRunArgsWithRepoSetup(dockerArgs, config.dockerImage, 'pi'), secretEnv, configEnv };
}
