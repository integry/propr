import fs from 'fs';
import logger from '../../utils/logger.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../claude/docker/repoSetupWrapper.js';
import { generateClaudePrompt, type IssueDetails, type IssueRef } from '../../claude/prompts/promptGenerator.js';
import type { AgentConfig } from '../types.js';
export { normalizeOpenCodeCliModelName, toOpenCodeExternalModelId, toProprOpenCodeExternalModelId, toProprOpenCodeModelId, toOpenCodeGoOpenRouterId } from './openCodeModelIds.js';
export { hasOpenCodeTokenUsage, isOpenCodeJsonlEvent, normalizeOpenCodeUsage, parseOpenCodeJsonl, parseOpenCodeStreamOutput } from './openCodeParsing.js';
export type { NormalizedOpenCodeUsage, OpenCodeEvent, OpenCodeUsage, ParsedOpenCodeOutput } from './openCodeParsing.js';
import { toOpenCodeExternalModelId } from './openCodeModelIds.js';

const CONTAINER_CONFIG_PATH = '/home/node/.config/opencode';

export interface BuildOpenCodePromptOptions { customPrompt?: string; issueRef: IssueRef; branchName?: string; modelName?: string; issueDetails?: IssueDetails; isRetry?: boolean; retryReason?: string; systemPrompt?: string; }

export interface OpenCodeDockerArgsParams {
    config: AgentConfig; worktreePath: string; githubToken: string; modelName?: string; issueNumber: number;
    taskId?: string; executionType?: string; readOnlyWorkspace?: boolean; allowDangerousPermissions?: boolean; configPath?: string;
    promptMode?: 'file' | 'direct'; dataPath?: string;
    ensureConfigPath?: (configPath: string) => void;
}

export function buildOpenCodePrompt(options: BuildOpenCodePromptOptions): string {
    const { customPrompt, issueRef, branchName, modelName, issueDetails, isRetry, retryReason, systemPrompt } = options;

    const basePrompt = customPrompt || generateClaudePrompt({
        issueRef, branchName: branchName ?? null, modelName: modelName ?? null, issueDetails: issueDetails ?? null
    });
    const systemContext = systemPrompt ? `SYSTEM INSTRUCTIONS:\n${systemPrompt}\n\n---\n\n` : '';
    let prompt = `${systemContext}${basePrompt}

**CRITICAL GIT SAFETY RULES:**
- NEVER run 'rm .git' or delete the .git file/directory
- NEVER run 'git init' in the workspace - this is already a git repository
- If you encounter git errors, report them but DO NOT attempt to reinitialize the repository
- The workspace is a git worktree linked to the main repository
- Only make changes to the specific files mentioned in the issue/request
- If git commands fail, describe the error but do NOT try destructive recovery methods
- The system will automatically commit your changes after you complete the modifications`;

    if (isRetry && retryReason) {
        prompt += `\n\n---\n\n**RETRY CONTEXT**: This is a retry attempt. Previous attempt failed with: ${retryReason}\n\nPlease address the issues from the previous attempt.`;
    }

    logger.debug({ issueNumber: issueRef.number, promptLength: prompt.length, hasSafetyRules: prompt.includes('CRITICAL GIT SAFETY RULES'), isCustomPrompt: !!customPrompt }, 'Generated OpenCode prompt with safety rules');

    return prompt;
}

export function buildOpenCodeDockerArgs(params: OpenCodeDockerArgsParams): string[] {
    const { config, worktreePath, githubToken, modelName, issueNumber, taskId, executionType, readOnlyWorkspace, allowDangerousPermissions = true, promptMode = 'file', dataPath, ensureConfigPath = ensureDirectory } = params;
    const configPath = params.configPath || resolveConfigPath(config.configPath);
    ensureConfigPath(configPath);
    const envVars = buildEnvVars(config);
    const dataMount = resolveOpenCodeDataMount(configPath, config.envVars, dataPath);
    const timestamp = Date.now().toString(36);
    const shortTaskId = taskId ? taskId.slice(-8) : timestamp;
    const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
    const containerName = buildOpenCodeContainerName(config.alias || 'opencode', taskType, shortTaskId, modelName);
    const workspaceMode = readOnlyWorkspace ? 'ro' : 'rw';
    const configMode = 'rw';
    const commandArgs = buildOpenCodeCommandArgs(promptMode);
    if (allowDangerousPermissions) commandArgs.push('--dangerously-skip-permissions');
    const dockerArgs = [
        'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
        '-v', `${worktreePath}:/home/node/workspace:${workspaceMode}`, '-v', '/tmp/git-processor:/tmp/git-processor:rw',
        '-v', `${configPath}:${CONTAINER_CONFIG_PATH}:${configMode}`,
        '-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`, '-e', 'OPENCODE_CONFIG_DIR=/home/node/.config/opencode',
        '-e', 'XDG_CONFIG_HOME=/home/node/.config', '-e', 'XDG_DATA_HOME=/home/node/.local/share', ...envVars,
        '-w', '/home/node/workspace', config.dockerImage, ...commandArgs
    ];
    appendOpenCodeDataMount(dockerArgs, dataMount);

    if (modelName) {
        const cleanModelName = toOpenCodeExternalModelId(modelName);
        dockerArgs.push('--model', cleanModelName);
        logger.info({ issueNumber, requestedModel: cleanModelName, originalModel: modelName, agentAlias: config.alias }, 'Model specified for OpenCode agent');
    }

    return wrapDockerRunArgsWithRepoSetup(dockerArgs, config.dockerImage, 'opencode');
}

function buildOpenCodeCommandArgs(promptMode: 'file' | 'direct'): string[] {
    if (promptMode === 'direct') {
        return [
            '/bin/sh',
            '-lc',
            // Write the prompt file INSIDE the workspace (OpenCode's project root,
            // cwd=/home/node/workspace) rather than /tmp. OpenCode treats paths
            // outside the project root as `external_directory`, whose permission is
            // "ask" — auto-rejected in this non-interactive run — so a /tmp prompt
            // file makes `--file` fail to read. The workspace is mounted rw for
            // analysis, and the file is dot-prefixed and cleaned up on exit. The
            // `out` capture file can stay in /tmp since OpenCode never reads it.
            'prompt_file="$(mktemp "${PWD:-/home/node/workspace}/.opencode-analysis-prompt.XXXXXX.md")"; out="$(mktemp)"; cleanup() { rm -f "$prompt_file" "$out"; }; trap cleanup EXIT; cat > "$prompt_file"; opencode run "$@" --file "$prompt_file" -- "The attached file is the trusted user prompt for this non-interactive CLI run. Follow the instructions in that file exactly." > "$out"; status=$?; cat "$out"; if [ "$status" -ne 0 ] || ! grep -q \'"type":"text"\' "$out"; then latest="$(ls -t /home/node/.local/share/opencode/log/*.log 2>/dev/null | head -1)"; [ -n "$latest" ] && tail -80 "$latest" >&2; fi; exit "$status"',
            'propr-opencode-direct',
            '--format',
            'json',
            '--title',
            'ProPR analysis'
        ];
    }
    return ['opencode-run', '--format', 'json', '--title', 'ProPR task'];
}

interface OpenCodeDataMount { hostPath: string; mode: 'ro' | 'rw'; }

function appendOpenCodeDataMount(dockerArgs: string[], dataMount: OpenCodeDataMount | null): void {
    if (!dataMount) return;
    dockerArgs.splice(
        dockerArgs.indexOf('-w'),
        0,
        '-v',
        `${dataMount.hostPath}:/home/node/.local/share/opencode:${dataMount.mode}`,
        '-e',
        'XDG_DATA_HOME=/home/node/.local/share'
    );
}

function resolveOpenCodeDataMount(configPath: string, envVars: AgentConfig['envVars'], explicitHostDataPath?: string): OpenCodeDataMount | null {
    const configuredHostDataPath = process.env.HOST_OPENCODE_DATA_DIR;
    if (configuredHostDataPath) return { hostPath: configuredHostDataPath, mode: 'rw' };
    if (explicitHostDataPath) return { hostPath: explicitHostDataPath, mode: 'rw' };
    if (envVars?.XDG_DATA_HOME) return null;
    const inferredHostDataPath = inferOpenCodeDataPath(configPath);
    return inferredHostDataPath && fs.existsSync(inferredHostDataPath)
        ? { hostPath: inferredHostDataPath, mode: 'rw' }
        : null;
}

function inferOpenCodeDataPath(configPath: string): string | null {
    const normalized = configPath.replace(/\/+$/, '');
    if (normalized.endsWith('/.config/opencode')) {
        return `${normalized.slice(0, -'/.config/opencode'.length)}/.local/share/opencode`;
    }
    return null;
}

function buildEnvVars(config: AgentConfig): string[] {
    const envVars: string[] = [];
    if (!config.envVars) return envVars;
    for (const [key, value] of Object.entries(config.envVars)) envVars.push('-e', `${key}=${value}`);
    return envVars;
}

function buildOpenCodeContainerName(alias: string, taskType: string, shortTaskId: string, modelName?: string): string {
    const suffix = `-${shortTaskId}`;
    const rawPrefix = modelName
        ? `${alias}-${taskType}-${modelName}`
        : `${alias}-${taskType}`;
    const maxPrefixLength = Math.max(1, 120 - suffix.length);
    const sanitizedPrefix = rawPrefix.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, maxPrefixLength).replace(/[^a-zA-Z0-9]+$/, '');
    const sanitized = `${sanitizedPrefix || 'opencode'}${suffix}`;
    return (sanitized || `opencode-${Date.now().toString(36)}`).slice(0, 128);
}

function ensureDirectory(configPath: string): void { fs.mkdirSync(configPath, { recursive: true, mode: 0o700 }); }
