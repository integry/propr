import { agentOwnsGit, buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../agentGitAccess.js';
import logger from '../../../utils/logger.js';
import type { AgentConfig, AgentToolPolicy } from '../../types.js';
import { codexToolPolicyArgs } from '../../agentToolPolicy.js';
import { agentContainerNetwork } from '../../agentContainerNetwork.js';
import {
    assertCodexConfigPathAvailable,
    resolveCodexConfigPath,
    type CodexRuntimeReasoningLevel
} from '../../../config/configManager.js';
import { applyAgentRunLaunchWrapper } from '../../../claude/docker/repoSetupWrapper.js';
import { AgentRunSpecBuilder, agentRunMcpGrant, agentRunNetwork } from '../../runtime/agentRunSpec.js';
import { renderDockerRunArgs } from '../../runtime/dockerRunArgs.js';
import type { AgentRunSpec } from '../../runtime/types.js';
import { createContainerExecutionId } from './containerExecutionId.js';
import {
    buildCodexRepositoryScoutArgs,
    REPOSITORY_SCOUT_CONTAINER_ROOT,
} from './repositoryScoutMcpServer.js';

const CONTAINER_CONFIG_PATH = '/home/node/.codex';
const GITHUB_CREDENTIAL_ENV_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ACCESS_TOKEN']);
const GITHUB_CREDENTIAL_ENV_PATTERN = /^(?:GH|GITHUB)_.*(?:TOKEN|KEY|SECRET|PASSWORD|PAT|PRIVATE_KEY)$/;
const PROPR_OPENAI_PROVIDER_ID = 'propr_openai';

export const DEFAULT_CODEX_STREAM_TRANSPORT = 'websocket' as const;
export const DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CODEX_STREAM_MAX_RETRIES = 5;

export type CodexStreamTransport = 'sse' | 'websocket' | 'inherit';

export interface CodexStreamConfig {
    transport: CodexStreamTransport;
    idleTimeoutMs: number;
    maxRetries: number;
}

function parseIntegerSetting(value: string | undefined, fallback: number, allowZero: boolean): number {
    if (!value?.trim()) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0)
        ? parsed
        : fallback;
}

export function resolveCodexStreamConfig(
    environment: Record<string, string | undefined> = process.env
): CodexStreamConfig {
    const configuredTransport = environment.CODEX_STREAM_TRANSPORT?.trim().toLowerCase();
    const transport: CodexStreamTransport = configuredTransport === 'sse'
        || configuredTransport === 'websocket'
        || configuredTransport === 'inherit'
        ? configuredTransport
        : DEFAULT_CODEX_STREAM_TRANSPORT;

    return {
        transport,
        idleTimeoutMs: parseIntegerSetting(
            environment.CODEX_STREAM_IDLE_TIMEOUT_MS,
            DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS,
            false
        ),
        maxRetries: parseIntegerSetting(
            environment.CODEX_STREAM_MAX_RETRIES,
            DEFAULT_CODEX_STREAM_MAX_RETRIES,
            true
        ),
    };
}

export function buildCodexStreamConfigArgs(config: CodexStreamConfig): string[] {
    if (config.transport === 'inherit') return [];

    return [
        '--config', `model_provider="${PROPR_OPENAI_PROVIDER_ID}"`,
        '--config', `model_providers.${PROPR_OPENAI_PROVIDER_ID}.name="OpenAI"`,
        '--config', `model_providers.${PROPR_OPENAI_PROVIDER_ID}.wire_api="responses"`,
        '--config', `model_providers.${PROPR_OPENAI_PROVIDER_ID}.requires_openai_auth=true`,
        '--config', `model_providers.${PROPR_OPENAI_PROVIDER_ID}.supports_websockets=${config.transport === 'websocket'}`,
        '--config', `model_providers.${PROPR_OPENAI_PROVIDER_ID}.supports_standalone_web_search=true`,
        '--config', `model_providers.${PROPR_OPENAI_PROVIDER_ID}.stream_idle_timeout_ms=${config.idleTimeoutMs}`,
        '--config', `model_providers.${PROPR_OPENAI_PROVIDER_ID}.stream_max_retries=${config.maxRetries}`,
        // Codex 0.163+ refuses to start `exec` when Daybreak (saved by the TUI's
        // /daybreak toggle in a mounted config.toml) is on for any provider other
        // than the built-in `openai`. Older CLIs only warn the key is ignored.
        '--config', 'daybreak=false',
    ];
}

function isGitHubCredentialEnvironmentVariable(name: string): boolean {
    const normalizedName = name.toUpperCase();
    return GITHUB_CREDENTIAL_ENV_NAMES.has(normalizedName)
        || GITHUB_CREDENTIAL_ENV_PATTERN.test(normalizedName);
}

function addEnvironmentVariables(
    builder: AgentRunSpecBuilder,
    sources: Array<Record<string, string> | undefined>,
    omitGitHubCredentials: boolean
): void {
    for (const source of sources) {
        if (!source) continue;
        for (const [key, value] of Object.entries(source)) {
            if (omitGitHubCredentials && isGitHubCredentialEnvironmentVariable(key)) continue;
            builder.env(key, value);
        }
    }
}

export interface CodexDockerArgsParams {
    worktreePath: string;
    githubToken: string;
    gitMountArgs?: string[];
    modelName?: string;
    issueNumber: number;
    jsonOutput?: boolean;
    environment?: Record<string, string>;
    taskId?: string;
    executionType?: string;
    reasoningLevel?: CodexRuntimeReasoningLevel | '';
    readOnlyWorkspace?: boolean;
    repositoryInspection?: boolean;
    executionMode?: 'task' | 'goal';
    resumeSessionId?: string;
    /** Per-run web/MCP policy; its tokens must reach the docker process through `extraEnvVars`. */
    toolPolicy?: AgentToolPolicy;
}

function resolveTaskType(params: CodexDockerArgsParams): string {
    if (params.executionMode === 'goal') return 'goal';
    return params.executionType || (params.issueNumber === 0 ? 'analysis' : `issue-${params.issueNumber}`);
}

function buildCodexCliArgs(params: CodexDockerArgsParams, streamConfig: CodexStreamConfig): string[] {
    const {
        executionMode = 'task',
        jsonOutput = true,
        reasoningLevel,
        repositoryInspection = false,
        resumeSessionId,
    } = params;
    const isGoalResume = executionMode === 'goal' && !!resumeSessionId;
    return [
        'codex', 'exec',
        ...(executionMode === 'task' ? ['--ephemeral'] : []),
        ...(isGoalResume ? ['resume'] : []),
        ...(jsonOutput ? ['--json'] : []),
        ...(repositoryInspection
            ? buildCodexRepositoryScoutArgs()
            : [
                '--dangerously-bypass-approvals-and-sandbox',
                // Normal tasks retain their one-shot single-agent contract.
                ...(executionMode === 'task' ? ['--config', 'features.multi_agent=false'] : []),
            ]),
        ...buildCodexStreamConfigArgs(streamConfig),
        ...(reasoningLevel ? ['--config', `model_reasoning_effort="${reasoningLevel}"`] : []),
        ...(params.toolPolicy ? codexToolPolicyArgs(params.toolPolicy).cliArgs : []),
        '--skip-git-repo-check',
        '--cd', '/home/node/workspace',
        ...(isGoalResume ? [resumeSessionId] : []),
        '-',
    ];
}

/**
 * Whether the run should trust /home/node/workspace so Codex loads the
 * repository's `.codex/config.toml` and project MCP servers. Up to 0.168,
 * `codex exec --dangerously-bypass-approvals-and-sandbox` saved that trust in
 * CODEX_HOME by itself; 0.169 needs `--trust`, which the entrypoint adds when
 * the installed CLI offers it. Repository inspection and exclusive-MCP runs
 * pass `--ignore-user-config` and must not load project configuration.
 */
export function codexTrustsWorkspace(params: Pick<CodexDockerArgsParams, 'repositoryInspection' | 'toolPolicy'>): boolean {
    return !params.repositoryInspection && !params.toolPolicy?.exclusiveMcp;
}

export function buildCodexRunSpec(config: AgentConfig, params: CodexDockerArgsParams): AgentRunSpec {
    const {
        worktreePath, githubToken, modelName, issueNumber, environment,
        taskId, readOnlyWorkspace = false, repositoryInspection = false,
    } = params;
    if (repositoryInspection && !readOnlyWorkspace) {
        throw new Error('Repository inspection requires a read-only workspace');
    }

    const dockerImage = config.dockerImage;
    const configPath = resolveCodexConfigPath(config.configPath);
    assertCodexConfigPathAvailable(configPath);
    const workerOwnedGit = !agentOwnsGit(params);
    const streamConfig = resolveCodexStreamConfig({
        ...process.env,
        ...config.envVars,
        ...environment,
    });
    const shortTaskId = createContainerExecutionId(taskId);
    const taskType = resolveTaskType(params);
    const containerName = `${config.alias || 'codex'}-${taskType}-${shortTaskId}`;
    const workspaceTarget = repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : '/home/node/workspace';
    const policy = params.toolPolicy;
    const builder = new AgentRunSpecBuilder({
        agentType: 'codex', image: dockerImage, alias: config.alias, name: containerName, stdin: true, user: '0:0',
        network: agentRunNetwork(agentContainerNetwork(policy)),
        security: { securityOpts: ['seccomp=unconfined', 'apparmor=unconfined'], capAdd: ['CHOWN'] },
        workspace: { hostPath: worktreePath, containerPath: workspaceTarget, readOnly: readOnlyWorkspace },
        mcpGrant: agentRunMcpGrant(policy),
    }).workspaceMount();
    if (!repositoryInspection) {
        builder.dockerOptions(params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, !workerOwnedGit, readOnlyWorkspace), 'git');
    }
    // Goal runs resume their session from the store, so they keep the direct mount.
    builder.credentialBind(configPath, CONTAINER_CONFIG_PATH, false, { provider: 'codex', store: 'config', perRun: params.executionMode !== 'goal' });
    if (!repositoryInspection) builder.env('GH_TOKEN', githubToken).env('GITHUB_TOKEN', githubToken);
    if (readOnlyWorkspace) builder.env('PROPR_REPO_SETUP', '0');
    addEnvironmentVariables(builder, [config.envVars, environment], true);
    if (policy?.exclusiveMcp) builder.env('PROPR_EXTENSION_EXCLUSIVE_MCP', '1');
    // Always set, after operator variables, so their envVars cannot change it.
    builder.env('PROPR_CODEX_TRUST_WORKSPACE', codexTrustsWorkspace(params) ? '1' : '0');
    // Name only: the runtime copies the value from the launch environment.
    for (const name of Object.keys(policy ? codexToolPolicyArgs(policy).env : {})) builder.env(name);
    builder.dockerOptions(buildAgentGitCredentialArgs(), 'credential');
    const cliArgs = buildCodexCliArgs(params, streamConfig);
    builder.command(...cliArgs);

    if (modelName) {
        const cleanModelName = modelName.includes(':') ? modelName.split(':').pop()! : modelName;
        const codexIndex = builder.spec.args.indexOf('codex');
        builder.spec.args.splice(codexIndex + 2, 0, '--model', cleanModelName);
        logger.info({ issueNumber, requestedModel: cleanModelName, agentAlias: config.alias }, 'Using specific model for Codex agent execution');
    } else {
        logger.debug({ issueNumber, agentAlias: config.alias }, 'No model specified, Codex agent will use default');
    }
    logger.info({ issueNumber, agentAlias: config.alias }, 'Docker args built for Codex agent');
    return applyAgentRunLaunchWrapper(builder.build(), 'codex');
}

export function buildCodexDockerArgs(config: AgentConfig, params: CodexDockerArgsParams): string[] {
    return renderDockerRunArgs(buildCodexRunSpec(config, params));
}

/** The same isolated goal run, but exposing Codex's native JSONL App Server. */
export function buildCodexAppServerRunSpec(config: AgentConfig, params: CodexDockerArgsParams): AgentRunSpec {
    const spec = buildCodexRunSpec(config, {
        ...params,
        modelName: undefined,
        jsonOutput: false,
        executionMode: 'goal',
        resumeSessionId: undefined,
    });
    const codexIndex = spec.args.lastIndexOf('codex');
    if (codexIndex < 0) throw new Error('Codex executable was not present in App Server container arguments');
    spec.args = [...spec.args.slice(0, codexIndex), 'codex', 'app-server'];
    return spec;
}

/** Build the same isolated goal container, but expose Codex's native JSONL App Server. */
export function buildCodexAppServerDockerArgs(config: AgentConfig, params: CodexDockerArgsParams): string[] {
    return renderDockerRunArgs(buildCodexAppServerRunSpec(config, params));
}
