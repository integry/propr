import fs from 'fs';
import type { AgentConfig } from '../../types.js';
import { CONTAINER_CONFIG_PATHS } from '../../types.js';
import type { PiThinkingLevel } from '../../../config/configManagerReasoning.js';
import { buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../agentGitAccess.js';
import { buildAgentContainerResourceArgs, wrapDockerRunArgsWithRepoSetup } from '../../../claude/docker/repoSetupWrapper.js';
import { openCodeEnvVarRejection } from '../openCodeEnvForwarding.js';
import { toPiCliModel } from '../piModelIds.js';
import { createContainerExecutionId } from './containerExecutionId.js';

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
/** Built-in tools that only read; analysis runs get these or none. */
const PI_READ_ONLY_TOOLS = 'read,grep,find,ls';

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
    /** Analysis may use Pi's read-only built-in tools on a read-only workspace. */
    readOnlyTools?: boolean;
}

export interface PiDockerInvocation {
    args: string[];
    /**
     * Secret values the container reads through `-e NAME`, passed in the docker
     * client's environment so they never appear in its argument list.
     */
    secretEnv: Record<string, string>;
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

/** `pi -p --mode json` arguments after the image; the prompt arrives on stdin. */
export function buildPiCliArgs(params: { modelName: string; thinkingLevel?: PiThinkingLevel | null; mode: 'execute' | 'analysis'; readOnlyTools?: boolean }): string[] {
    const { model, thinking } = toPiCliModel(params.modelName);
    const effectiveThinking = params.thinkingLevel ?? thinking;
    const args = ['pi', '-p', '--mode', 'json', '--model', thinking ? `${model}:${thinking}` : model];
    if (effectiveThinking) args.push('--thinking', effectiveThinking);
    if (params.mode === 'analysis') {
        // Lightweight analysis keeps nothing and runs no tool that can write.
        args.push('--no-session', ...(params.readOnlyTools ? ['--tools', PI_READ_ONLY_TOOLS] : ['--no-tools']));
    } else {
        args.push('--session-dir', PI_CONTAINER_SESSION_DIR);
    }
    // Never trust repository-provided .pi/ extensions, settings or prompts.
    // AGENTS.md / CLAUDE.md context files still load.
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
 * `docker run` arguments for one Pi run. The container starts as root only so
 * pi-entrypoint.sh can seed and chown the disposable Pi home; every Pi process
 * runs as node.
 */
export function buildPiDockerArgs(params: PiDockerArgsParams, githubToken: string): PiDockerInvocation {
    const { config, worktreePath, configPath, modelName, thinkingLevel, issueNumber, taskId, executionType, mode = 'execute', readOnlyTools = false } = params;
    const analysis = mode === 'analysis';
    const workspaceMode = analysis ? 'ro' : 'rw';
    const secretEnv: Record<string, string> = { ...forwardablePiEnvVars(config.envVars) };
    if (githubToken) Object.assign(secretEnv, { GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken });
    // A missing host dir is not mounted: Docker would create it, root-owned, on the host.
    // The mount is writable so refreshed OAuth tokens can be written back (pi-credentials.py).
    const configMountArgs = configPath && fs.existsSync(configPath) ? ['-v', `${configPath}:${PI_CONTAINER_SOURCE_DIR}:rw`] : [];
    const containerName = buildPiContainerName(config.alias, executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`), taskId, modelName);
    const dockerArgs = [
        'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--network', 'bridge', '--user', '0:0',
        '-v', `${worktreePath}:${WORKSPACE}:${workspaceMode}`,
        ...(params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, false, analysis)),
        ...configMountArgs,
        '-e', 'PROPR_AGENT_TYPE=pi',
        '-e', `PROPR_PI_SOURCE_DIR=${PI_CONTAINER_SOURCE_DIR}`,
        '-e', `PROPR_PI_RUNTIME_HOME=${PI_CONTAINER_RUNTIME_HOME}`,
        ...(analysis ? ['-e', 'PROPR_REPO_SETUP=0'] : []),
        ...Object.keys(secretEnv).flatMap(name => ['-e', name]),
        ...buildAgentGitCredentialArgs(),
        '-w', WORKSPACE, config.dockerImage,
        ...buildPiCliArgs({ modelName, thinkingLevel, mode, readOnlyTools }),
    ];
    if (analysis) return { args: [dockerArgs[0], ...buildAgentContainerResourceArgs(), ...dockerArgs.slice(1)], secretEnv };
    return { args: wrapDockerRunArgsWithRepoSetup(dockerArgs, config.dockerImage, 'pi'), secretEnv };
}
