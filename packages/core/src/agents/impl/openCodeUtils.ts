import fs from 'fs';
import logger from '../../utils/logger.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../claude/docker/repoSetupWrapper.js';
import type { AgentConfig } from '../types.js';

const CONTAINER_CONFIG_PATH = '/home/node/.config/opencode';

export interface OpenCodeEvent {
    type?: string;
    timestamp?: number | string;
    sessionID?: string;
    sessionId?: string;
    session_id?: string;
    part?: OpenCodePart;
    parts?: OpenCodePart[];
    message?: OpenCodeMessage;
    error?: { name?: string; data?: { message?: string }; message?: string } | string;
    model?: string;
    text?: string;
    content?: unknown;
    delta?: string;
    response?: OpenCodeTextContainer;
}

interface OpenCodeTextContainer {
    text?: string;
    content?: unknown;
    delta?: string;
}

interface OpenCodePart extends OpenCodeTextContainer {
    type?: string;
    messageID?: string;
    sessionID?: string;
}

interface OpenCodeMessage extends OpenCodeTextContainer {
    role?: string;
    model?: string;
    parts?: OpenCodePart[];
}

export interface ParsedOpenCodeOutput {
    sessionId?: string;
    modelUsed?: string;
    summary?: string;
    error?: string;
    conversationLog: OpenCodeEvent[];
}

interface OpenCodeParseState {
    sessionId?: string;
    modelUsed?: string;
    error?: string;
    streamTextParts: string[];
    assistantMessages: string[];
}

interface ExtractedOpenCodeText {
    streamParts: string[];
    assistantMessage?: string;
}

export interface OpenCodeDockerArgsParams {
    config: AgentConfig;
    worktreePath: string;
    githubToken: string;
    modelName?: string;
    issueNumber: number;
    taskId?: string;
    executionType?: string;
    readOnlyWorkspace?: boolean;
    allowDangerousPermissions?: boolean;
    configPath?: string;
    ensureConfigPath?: (configPath: string) => void;
}

export function parseOpenCodeJsonl(output: string): ParsedOpenCodeOutput {
    const conversationLog: OpenCodeEvent[] = [];
    const state: OpenCodeParseState = { streamTextParts: [], assistantMessages: [] };

    for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line) as OpenCodeEvent;
            conversationLog.push(event);
            applyOpenCodeEvent(event, state);
        } catch {
            logger.debug({ linePreview: line.substring(0, 100) }, 'Non-JSON line in OpenCode output');
            state.streamTextParts.push(line);
        }
    }

    return {
        sessionId: state.sessionId,
        modelUsed: state.modelUsed,
        summary: buildOpenCodeSummary(state),
        error: state.error,
        conversationLog
    };
}

export function buildOpenCodeDockerArgs(params: OpenCodeDockerArgsParams): string[] {
    const {
        config,
        worktreePath,
        githubToken,
        modelName,
        issueNumber,
        taskId,
        executionType,
        readOnlyWorkspace,
        allowDangerousPermissions = true,
        ensureConfigPath = ensureDirectory
    } = params;
    const configPath = params.configPath || resolveConfigPath(config.configPath);
    ensureConfigPath(configPath);
    const envVars = buildEnvVars(config);
    const timestamp = Date.now().toString(36);
    const shortTaskId = taskId ? taskId.slice(-8) : timestamp;
    const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
    const containerName = buildOpenCodeContainerName(config.alias || 'opencode', taskType, shortTaskId);
    const workspaceMode = readOnlyWorkspace ? 'ro' : 'rw';
    const commandArgs = ['opencode-run', '--format', 'json'];
    if (allowDangerousPermissions) commandArgs.push('--dangerously-skip-permissions');
    const dockerArgs = [
        'run', '--rm', '-i', '--name', containerName, '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
        '-v', `${worktreePath}:/home/node/workspace:${workspaceMode}`, '-v', '/tmp/git-processor:/tmp/git-processor:rw',
        '-v', `${configPath}:${CONTAINER_CONFIG_PATH}:rw`,
        '-e', `GH_TOKEN=${githubToken}`, '-e', `GITHUB_TOKEN=${githubToken}`, '-e', 'OPENCODE_CONFIG_DIR=/home/node/.config/opencode',
        '-e', 'XDG_CONFIG_HOME=/home/node/.config', '-e', 'XDG_DATA_HOME=/home/node/.local/share', ...envVars,
        '-w', '/home/node/workspace', config.dockerImage, ...commandArgs
    ];

    if (modelName) {
        const cleanModelName = modelName.startsWith('opencode:') ? modelName.slice('opencode:'.length) : modelName;
        dockerArgs.push('--model', cleanModelName);
        logger.info({ issueNumber, requestedModel: cleanModelName, originalModel: modelName, agentAlias: config.alias }, 'Model specified for OpenCode agent');
    }

    return wrapDockerRunArgsWithRepoSetup(dockerArgs, config.dockerImage, 'opencode');
}

function buildEnvVars(config: AgentConfig): string[] {
    const envVars: string[] = [];
    if (!config.envVars) return envVars;
    for (const [key, value] of Object.entries(config.envVars)) envVars.push('-e', `${key}=${value}`);
    return envVars;
}

function applyOpenCodeEvent(event: OpenCodeEvent, state: OpenCodeParseState): void {
    state.sessionId = state.sessionId || event.sessionID || event.sessionId || event.session_id || event.part?.sessionID;
    applyOpenCodeModel(event, state);
    const text = extractOpenCodeText(event);
    state.streamTextParts.push(...text.streamParts);
    if (text.assistantMessage) state.assistantMessages.push(text.assistantMessage);
    if (event.type?.toLowerCase() === 'error' || event.error) {
        state.error = extractOpenCodeError(event);
    }
}

function applyOpenCodeModel(event: OpenCodeEvent, state: OpenCodeParseState): void {
    const assistantModel = event.message?.role === 'assistant' ? event.message.model : undefined;
    if (assistantModel) {
        state.modelUsed = assistantModel;
        return;
    }
    const type = event.type?.toLowerCase();
    if (!state.modelUsed && event.model && type !== 'error' && !event.error) state.modelUsed = event.model;
}

function buildOpenCodeSummary(state: OpenCodeParseState): string | undefined {
    const lastAssistantMessage = state.assistantMessages.at(-1)?.trim();
    if (lastAssistantMessage) return lastAssistantMessage;
    return state.streamTextParts.join('').trim() || undefined;
}

function extractOpenCodeText(event: OpenCodeEvent): ExtractedOpenCodeText {
    const streamParts: string[] = [];
    const messageParts: string[] = [];
    addPartText(streamParts, event.part);
    addPartsText(streamParts, event.parts);
    const hasEventParts = Boolean(event.part || event.parts?.length);
    const assistantMessage = event.message?.role === 'assistant' ? event.message : undefined;
    if (assistantMessage) {
        addTextContainer(messageParts, assistantMessage);
        addPartsText(messageParts, assistantMessage.parts);
    }
    if (!hasEventParts && !assistantMessage && isAssistantTextEvent(event)) {
        addTextContainer(streamParts, event);
        addTextContainer(streamParts, event.response);
    }
    return {
        streamParts: Array.from(new Set(streamParts)),
        assistantMessage: Array.from(new Set(messageParts)).join('') || undefined
    };
}

function addPartsText(textParts: string[], parts?: OpenCodePart[]): void {
    for (const part of parts || []) addPartText(textParts, part);
}

function addPartText(textParts: string[], part?: OpenCodePart): void {
    if (!part) return;
    const partType = part.type?.toLowerCase();
    if (partType && !['text', 'assistant_text', 'message', 'completion'].includes(partType)) return;
    addTextContainer(textParts, part);
}

function addTextContainer(textParts: string[], container?: OpenCodeTextContainer): void {
    if (!container) return;
    for (const value of [container.text, container.delta, container.content]) {
        if (typeof value === 'string' && value.length > 0) textParts.push(value);
    }
}

function isAssistantTextEvent(event: OpenCodeEvent): boolean {
    const type = event.type?.toLowerCase();
    return !!type && ['text', 'assistant', 'message', 'delta', 'completion'].includes(type);
}

function extractOpenCodeError(event: OpenCodeEvent): string {
    if (typeof event.error === 'string') return event.error;
    return event.error?.data?.message || event.error?.message || event.error?.name || 'OpenCode execution failed';
}

function buildOpenCodeContainerName(alias: string, taskType: string, shortTaskId: string): string {
    const rawName = `${alias}-${taskType}-${shortTaskId}`;
    const sanitized = rawName.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 120);
    return sanitized || `opencode-${Date.now().toString(36)}`;
}

function ensureDirectory(configPath: string): void {
    fs.mkdirSync(configPath, { recursive: true, mode: 0o700 });
}
