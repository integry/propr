import fs from 'fs';
import path from 'node:path';
import type { AgentConfig, AgentToolPolicy } from '../../types.js';
import type { PiThinkingLevel } from '../../../config/configManagerReasoning.js';
import { buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../agentGitAccess.js';
import { agentContainerNetwork } from '../../agentContainerNetwork.js';
import { piToolPolicyArgs } from '../../agentToolPolicy.js';
import { buildAgentContainerResourceArgs, wrapDockerRunArgsWithRepoSetup } from '../../../claude/docker/repoSetupWrapper.js';
import { openCodeEnvVarRejection } from '../openCodeEnvForwarding.js';
import { toPiCliModel } from '../piModelIds.js';
import { createContainerExecutionId } from './containerExecutionId.js';
import { buildPiRepositoryScoutArgs, buildPiRepositoryScoutConfig, REPOSITORY_SCOUT_CONTAINER_ROOT } from './repositoryScoutMcpServer.js';
import { PI_CONTAINER_GOAL_SESSION_DIR, PI_GOAL_SESSION_DIR_ENV, piGoalSessionCliArgs, type PiGoalSession } from './piGoalSession.js';

/** Root-only traversal protects the write-back mount from Pi and repository hooks. */
export const PI_CONTAINER_SOURCE_DIR = '/root/propr-pi-source';
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
    'PROPR_PI_CREDENTIALS_HELPER', 'PROPR_PI_MCP_CONFIG', 'PROPR_PI_GOAL_SESSION_DIR', 'PROPR_PI_LOGIN', 'PROPR_PI_NODE_PATH',
    'PROPR_AGENT_TYPE', 'HOME', 'USER', 'PATH',
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
    /** Goal runs only: the goal's persisted session store and how to open its session. */
    goalSession?: PiGoalSession;
    /** Per-execution variables (goal mode and admission parent); passed by name like secrets. */
    environment?: Record<string, string>;
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
export function buildPiCliArgs(params: { modelName: string; thinkingLevel?: PiThinkingLevel | null; mode: 'execute' | 'analysis'; repositoryInspection?: boolean; toolPolicyArgs?: string[]; goalSession?: PiGoalSession }): string[] {
    if (params.repositoryInspection && params.mode !== 'analysis') throw new Error('Repository inspection requires analysis mode');
    if (params.goalSession && params.mode !== 'execute') throw new Error('A Pi goal session requires execute mode');
    // One source of truth for the thinking level: `--thinking` only. The
    // caller's level already ranks the model id's suffix against ProPR's
    // levels; the suffix alone applies when no level was resolved.
    const { model, thinking } = toPiCliModel(params.modelName);
    const effectiveThinking = params.thinkingLevel ?? thinking;
    const args = ['pi', '-p', '--mode', 'json', '--model', model];
    if (effectiveThinking) args.push('--thinking', effectiveThinking);
    if (params.mode === 'analysis') {
        // Lightweight analysis keeps nothing and runs no tool that can write.
        args.push('--no-session');
        if (params.repositoryInspection) return [...args, ...buildPiRepositoryScoutArgs()];
        args.push('--no-tools');
    } else {
        // A goal keeps its session across runs; a task's session is disposable.
        args.push(...(params.goalSession ? piGoalSessionCliArgs(params.goalSession) : ['--session-dir', PI_CONTAINER_SESSION_DIR]), ...(params.toolPolicyArgs ?? []));
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
function buildPiContainerEnv(params: { config: AgentConfig; githubToken: string; repositoryInspection: boolean; toolPolicy?: AgentToolPolicy; environment?: Record<string, string> }): { secretEnv: Record<string, string>; configEnv: Record<string, string>; cliArgs?: string[] } {
    const policy = params.toolPolicy ? piToolPolicyArgs(params.toolPolicy) : undefined;
    const secretEnv: Record<string, string> = { ...forwardablePiEnvVars(params.config.envVars) };
    // ProPR's own per-run values (goal mode, the admission parent and its signing key).
    for (const [name, value] of Object.entries(params.environment ?? {})) {
        if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_PI_ENV_NAMES.has(name)) secretEnv[name] = value;
    }
    if (params.githubToken && !params.repositoryInspection) Object.assign(secretEnv, { GH_TOKEN: params.githubToken, GITHUB_TOKEN: params.githubToken });
    if (policy) Object.assign(secretEnv, policy.env);
    const mcpConfig = params.repositoryInspection ? buildPiRepositoryScoutConfig() : policy?.mcpConfig;
    return { secretEnv, configEnv: mcpConfig ? { [PI_MCP_CONFIG_ENV]: mcpConfig } : {}, cliArgs: policy?.cliArgs };
}

/** Host paths of the writable `-v`/`--volume` mounts in a docker argument list. */
function writableVolumeHostPaths(mountArgs: string[]): string[] {
    const hostPaths: string[] = [];
    for (const [index, arg] of mountArgs.entries()) {
        if (arg !== '-v' && arg !== '--volume') continue;
        const [hostPath, , mode] = (mountArgs[index + 1] ?? '').split(':');
        if (hostPath && !mode?.split(',').includes('ro')) hostPaths.push(hostPath);
    }
    return hostPaths;
}

/**
 * The host Pi dir's mount under the root-only source parent. Docker would
 * create a missing host directory, so only an existing source is mounted, and
 * never one that overlaps a writable container mount.
 */
function buildPiConfigMountArgs(params: { configPath?: string; writablePaths: string[]; gitMountArgs: string[] }): string[] {
    const { configPath } = params;
    if (!configPath || !fs.existsSync(configPath)) return [];
    const source = fs.realpathSync(configPath);
    for (const hostPath of [...params.writablePaths, ...writableVolumeHostPaths(params.gitMountArgs)]) {
        const writable = fs.existsSync(hostPath) ? fs.realpathSync(hostPath) : path.resolve(hostPath);
        if (source === writable || source.startsWith(path.join(writable, path.sep)) || writable.startsWith(path.join(source, path.sep))) {
            throw new Error('The Pi credential source overlaps a writable container mount');
        }
    }
    return ['-v', `${configPath}:${PI_CONTAINER_SOURCE_DIR}:rw`];
}

/**
 * `docker run` arguments for one Pi run. The container starts as root only so
 * pi-entrypoint.sh can seed and chown the disposable Pi home; every Pi process
 * runs as node.
 */
export function buildPiDockerArgs(params: PiDockerArgsParams, githubToken: string): PiDockerInvocation {
    const { config, worktreePath, configPath, modelName, thinkingLevel, issueNumber, taskId, executionType, mode = 'execute', repositoryInspection = false, goalSession } = params;
    const analysis = mode === 'analysis';
    if (repositoryInspection && !analysis) throw new Error('Repository inspection requires analysis mode');
    if (goalSession && analysis) throw new Error('A Pi goal session requires execute mode');
    // Tool policies (MCP servers, extension items) only apply to task runs.
    const toolPolicy = analysis ? undefined : params.toolPolicy;
    const { secretEnv, configEnv, cliArgs: toolPolicyArgs } = buildPiContainerEnv({ config, githubToken, repositoryInspection, toolPolicy, environment: analysis ? undefined : params.environment });
    const workspaceMode = analysis ? 'ro' : 'rw';
    const gitMountArgs = repositoryInspection ? [] : params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, false, analysis);
    const configMountArgs = buildPiConfigMountArgs({ configPath, writablePaths: [...(analysis ? [] : [worktreePath]), ...(goalSession ? [goalSession.hostDir] : [])], gitMountArgs });
    const containerName = buildPiContainerName(config.alias, executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`), taskId, modelName);
    const dockerArgs = [
        'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--network', agentContainerNetwork(toolPolicy), '--user', '0:0',
        // The scout sees the repository only through its MCP server's root, never the working directory.
        '-v', `${worktreePath}:${repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : WORKSPACE}:${workspaceMode}`,
        ...gitMountArgs,
        ...configMountArgs,
        ...(goalSession ? ['-v', `${goalSession.hostDir}:${PI_CONTAINER_GOAL_SESSION_DIR}:rw`, '-e', `${PI_GOAL_SESSION_DIR_ENV}=${PI_CONTAINER_GOAL_SESSION_DIR}`] : []),
        '-e', 'PROPR_AGENT_TYPE=pi',
        '-e', `PROPR_PI_SOURCE_DIR=${PI_CONTAINER_SOURCE_DIR}`,
        '-e', `PROPR_PI_RUNTIME_HOME=${PI_CONTAINER_RUNTIME_HOME}`,
        ...(analysis ? ['-e', 'PROPR_REPO_SETUP=0'] : []),
        ...Object.keys(secretEnv).flatMap(name => ['-e', name]),
        ...Object.keys(configEnv).flatMap(name => ['-e', name]),
        ...buildAgentGitCredentialArgs(),
        '-w', WORKSPACE, config.dockerImage,
        ...buildPiCliArgs({ modelName, thinkingLevel, mode, repositoryInspection, toolPolicyArgs, goalSession }),
    ];
    if (analysis) return { args: [dockerArgs[0], ...buildAgentContainerResourceArgs(), ...dockerArgs.slice(1)], secretEnv, configEnv };
    return { args: wrapDockerRunArgsWithRepoSetup(dockerArgs, config.dockerImage, 'pi'), secretEnv, configEnv };
}
