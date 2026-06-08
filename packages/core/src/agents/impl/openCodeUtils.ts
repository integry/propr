import fs from 'fs';
import logger from '../../utils/logger.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../claude/docker/repoSetupWrapper.js';
import { generateClaudePrompt, type IssueDetails, type IssueRef } from '../../claude/prompts/promptGenerator.js';
import type { AgentConfig, TokenUsage } from '../types.js';
export { normalizeOpenCodeCliModelName, toOpenCodeExternalModelId, toProprOpenCodeModelId } from './openCodeModelIds.js';
import { toOpenCodeExternalModelId, toProprOpenCodeModelId } from './openCodeModelIds.js';

const CONTAINER_CONFIG_PATH = '/home/node/.config/opencode';
const OPEN_CODE_TEXT_EVENT_TYPES = new Set(['text', 'delta', 'completion', 'reasoning']);
const OPEN_CODE_TOOL_EVENT_TYPES = new Set(['tool_use', 'tool_result', 'tool', 'tool_call', 'tool_response']);

export interface BuildOpenCodePromptOptions { customPrompt?: string; issueRef: IssueRef; branchName?: string; modelName?: string; issueDetails?: IssueDetails; isRetry?: boolean; retryReason?: string; systemPrompt?: string; }

export interface OpenCodeEvent {
    type?: string; timestamp?: number | string;
    sessionID?: string; sessionId?: string; session_id?: string; part?: OpenCodePart; parts?: OpenCodePart[]; message?: OpenCodeMessage;
    error?: { name?: string; data?: { message?: string }; message?: string } | string;
    model?: string; text?: string; content?: unknown; delta?: string;
    tool?: string; tool_name?: string; name?: string; input?: Record<string, unknown>; parameters?: Record<string, unknown>; args?: Record<string, unknown>;
    output?: string; result?: string; status?: string; id?: string; tool_id?: string;
    response?: OpenCodeTextContainer;
    usage?: OpenCodeUsage; stats?: OpenCodeUsage; tokens?: OpenCodeUsage;
}

interface OpenCodeTextContainer { text?: string; content?: unknown; delta?: string; usage?: OpenCodeUsage; }

export type OpenCodeUsage = Record<string, unknown>;

export interface NormalizedOpenCodeUsage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; }

interface OpenCodePart extends OpenCodeTextContainer {
    type?: string; messageID?: string; sessionID?: string; callID?: string; tokens?: OpenCodeUsage;
    state?: {
        status?: string; input?: Record<string, unknown>; output?: string; error?: unknown; title?: string;
        metadata?: { output?: string; exit?: number; [key: string]: unknown };
    };
    tool?: string; tool_name?: string; name?: string; input?: Record<string, unknown>; parameters?: Record<string, unknown>; args?: Record<string, unknown>;
    output?: string; result?: string; status?: string; id?: string; tool_id?: string;
}

interface OpenCodeMessage extends OpenCodeTextContainer { role?: string; model?: string; parts?: OpenCodePart[]; }

export interface ParsedOpenCodeOutput { sessionId?: string; modelUsed?: string; summary?: string; error?: string; tokenUsage?: TokenUsage; conversationLog: OpenCodeEvent[]; }

interface OpenCodeParseState {
    sessionId?: string; modelUsed?: string; error?: string; tokenUsage: TokenUsage; lastCumulativeTopLevelUsage?: TokenUsage;
    streamTextParts: string[]; assistantMessages: string[];
}

interface ExtractedOpenCodeText { streamParts: string[]; assistantMessage?: string; }

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

export function parseOpenCodeJsonl(output: string): ParsedOpenCodeOutput {
    const conversationLog: OpenCodeEvent[] = [];
    const state: OpenCodeParseState = { streamTextParts: [], assistantMessages: [], tokenUsage: {} };

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

    return { sessionId: state.sessionId, modelUsed: state.modelUsed, summary: buildOpenCodeSummary(state), error: state.error, tokenUsage: hasOpenCodeTokenUsage(state.tokenUsage) ? state.tokenUsage : undefined, conversationLog };
}

export const parseOpenCodeStreamOutput = parseOpenCodeJsonl;

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
            'prompt="$(cat)"; out="$(mktemp)"; opencode run "$@" -- "$prompt" > "$out"; status=$?; cat "$out"; if [ "$status" -ne 0 ] || ! grep -q \'"type":"text"\' "$out"; then latest="$(ls -t /home/node/.local/share/opencode/log/*.log 2>/dev/null | head -1)"; [ -n "$latest" ] && tail -80 "$latest" >&2; fi; rm -f "$out"; exit "$status"',
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

function applyOpenCodeEvent(event: OpenCodeEvent, state: OpenCodeParseState): void {
    state.sessionId = state.sessionId || event.sessionID || event.sessionId || event.session_id || event.part?.sessionID;
    applyOpenCodeModel(event, state);
    applyOpenCodeUsage(event, state);
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
        state.modelUsed = toProprOpenCodeModelId(assistantModel);
        return;
    }
    const type = event.type?.toLowerCase();
    if (!state.modelUsed && event.model && type !== 'error' && !event.error) state.modelUsed = toProprOpenCodeModelId(event.model);
}

function applyOpenCodeUsage(event: OpenCodeEvent, state: OpenCodeParseState): void {
    const topLevelUsage: TokenUsage = {};
    const nestedUsage: TokenUsage = {};
    for (const usage of [
        normalizeOpenCodeUsage(event.usage),
        normalizeOpenCodeUsage(event.stats),
        normalizeOpenCodeUsage(event.tokens),
        normalizeOpenCodeUsage(event.part?.tokens)
    ]) {
        if (usage) mergeOpenCodeUsageByMax(topLevelUsage, usage);
    }
    for (const usage of [
        normalizeOpenCodeUsage(event.message?.usage),
        normalizeOpenCodeUsage(event.response?.usage)
    ]) {
        if (usage) mergeOpenCodeUsageByMax(nestedUsage, usage);
    }
    if (hasOpenCodeTokenUsage(nestedUsage)) addOpenCodeUsage(state.tokenUsage, nestedUsage);
    if (hasOpenCodeTokenUsage(topLevelUsage)) {
        if (isOpenCodeCumulativeUsageEvent(event)) {
            mergeOpenCodeUsageByMax(state.tokenUsage, topLevelUsage);
            state.lastCumulativeTopLevelUsage = topLevelUsage;
        } else if (isCumulativeOpenCodeUsageSnapshot(topLevelUsage, state.lastCumulativeTopLevelUsage)) {
            mergeOpenCodeUsageByMax(state.tokenUsage, topLevelUsage);
            state.lastCumulativeTopLevelUsage = topLevelUsage;
        } else {
            addOpenCodeUsage(state.tokenUsage, topLevelUsage);
        }
    }
}

export function isOpenCodeJsonlEvent(event: { type?: unknown; sessionID?: unknown; sessionId?: unknown; session_id?: unknown; part?: unknown; parts?: unknown[]; message?: unknown; response?: unknown; text?: unknown; content?: unknown; delta?: unknown; tool?: unknown; tool_name?: unknown; name?: unknown; input?: unknown; parameters?: unknown; args?: unknown; usage?: OpenCodeUsage; stats?: OpenCodeUsage; tokens?: OpenCodeUsage }): boolean {
    const type = typeof event.type === 'string' ? event.type.toLowerCase() : undefined;
    const message = event.message && typeof event.message === 'object'
        ? event.message as { role?: unknown; parts?: unknown[] }
        : null;
    const hasOpenCodePayload = hasOpenCodeEventPayload(event, type, message);
    return Boolean(
        (event.sessionID && hasOpenCodePayload)
        || (event.sessionId && message?.role === 'assistant')
        || (event.session_id && hasOpenCodePayload)
        || hasOpenCodePayload
    );
}

function hasOpenCodeEventPayload(event: { sessionID?: unknown; sessionId?: unknown; session_id?: unknown; part?: unknown; parts?: unknown[]; message?: unknown; response?: unknown; text?: unknown; content?: unknown; delta?: unknown; usage?: OpenCodeUsage; stats?: OpenCodeUsage; tokens?: OpenCodeUsage }, type: string | undefined, message: { role?: unknown; parts?: unknown[] } | null): boolean {
    const hasOpenCodeIdentity = Boolean(event.sessionID || event.sessionId || event.session_id);
    const hasUsage = hasOpenCodeResultUsage(event, type, hasOpenCodeIdentity);
    const hasNestedUsage = hasOpenCodeNestedUsage(event);
    const hasAssistantText = message?.role === 'assistant' && hasOpenCodeTextField(event.message as { text?: unknown; content?: unknown; delta?: unknown });
    const hasResponseText = hasOpenCodeIdentity && isOpenCodeTextContainer(event.response);
    const checks = [
        Boolean(event.part),
        Boolean(event.parts?.length),
        Boolean(message?.parts?.length),
        hasAssistantText,
        hasResponseText,
        Boolean(type && OPEN_CODE_TEXT_EVENT_TYPES.has(type) && hasOpenCodeTextField(event)),
        Boolean(hasOpenCodeIdentity && type && OPEN_CODE_TOOL_EVENT_TYPES.has(type)),
        Boolean(type === 'result' && hasUsage),
        Boolean(hasOpenCodeIdentity && (hasUsage || hasNestedUsage))
    ];
    return checks.some(Boolean);
}

function hasOpenCodeResultUsage(event: { usage?: OpenCodeUsage; stats?: OpenCodeUsage; tokens?: OpenCodeUsage }, type?: string, hasOpenCodeIdentity = false): boolean {
    const usage = normalizeOpenCodeUsage(event.usage) || normalizeOpenCodeUsage(event.tokens);
    if (usage || type !== 'result') return Boolean(usage);
    return hasOpenCodeIdentity && Boolean(normalizeOpenCodeUsage(event.stats));
}

function hasOpenCodeNestedUsage(event: { message?: unknown; response?: unknown }): boolean {
    return Boolean(
        normalizeOpenCodeUsage(getOpenCodeNestedUsage(event.message))
        || normalizeOpenCodeUsage(getOpenCodeNestedUsage(event.response))
    );
}

function getOpenCodeNestedUsage(value: unknown): OpenCodeUsage | undefined {
    if (!value || typeof value !== 'object' || !('usage' in value)) return undefined;
    const usage = (value as { usage?: unknown }).usage;
    return usage && typeof usage === 'object' ? usage as OpenCodeUsage : undefined;
}

function isOpenCodeTextContainer(value: unknown): value is { text?: unknown; content?: unknown; delta?: unknown } { return Boolean(value && typeof value === 'object' && hasOpenCodeTextField(value as { text?: unknown; content?: unknown; delta?: unknown })); }

function isOpenCodeCumulativeUsageEvent(event: OpenCodeEvent): boolean {
    return event.type?.toLowerCase() === 'result';
}

export function normalizeOpenCodeUsage(usage: OpenCodeUsage | undefined): NormalizedOpenCodeUsage | undefined {
    if (!usage) return undefined;
    const inputTokens = firstNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'input', 'prompt']);
    const outputTokens = firstNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'output', 'completion']);
    const cacheCreationTokens = firstNumber(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheCreationTokens', 'cache_write', 'cacheWrite'])
        ?? nestedNumber(usage, 'cache', ['write']);
    const cacheReadTokens = firstNumber(usage, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens', 'cachedInputTokens', 'cacheReadTokens', 'cache_read', 'cacheRead'])
        ?? nestedNumber(usage, 'cache', ['read']);
    const normalized: NormalizedOpenCodeUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: cacheReadTokens
    };
    return hasOpenCodeTokenUsage(normalized) ? normalized : undefined;
}

function firstNumber(source: OpenCodeUsage, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
    return undefined;
}

function nestedNumber(source: OpenCodeUsage, objectKey: string, keys: string[]): number | undefined {
    const nested = source[objectKey];
    if (!nested || typeof nested !== 'object') return undefined;
    return firstNumber(nested as OpenCodeUsage, keys);
}

function mergeOpenCodeUsageByMax(target: TokenUsage, usage: NormalizedOpenCodeUsage): void {
    setTokenUsageField(target, 'input_tokens', Math.max(target.input_tokens ?? 0, usage.input_tokens ?? 0));
    setTokenUsageField(target, 'output_tokens', Math.max(target.output_tokens ?? 0, usage.output_tokens ?? 0));
    setTokenUsageField(target, 'cache_creation_input_tokens', Math.max(target.cache_creation_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0));
    setTokenUsageField(target, 'cache_read_input_tokens', Math.max(target.cache_read_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0));
}

function isCumulativeOpenCodeUsageSnapshot(current: TokenUsage, previous?: TokenUsage): boolean {
    if (!previous || !hasOpenCodeTokenUsage(previous)) return false;
    const fields: Array<keyof TokenUsage> = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
    let hasIncrease = false;
    for (const field of fields) {
        const currentValue = current[field] ?? 0;
        const previousValue = previous[field] ?? 0;
        if (currentValue < previousValue) return false;
        if (currentValue > previousValue) hasIncrease = true;
    }
    return hasIncrease;
}

function addOpenCodeUsage(target: TokenUsage, usage: TokenUsage): void {
    setTokenUsageField(target, 'input_tokens', (target.input_tokens ?? 0) + (usage.input_tokens ?? 0));
    setTokenUsageField(target, 'output_tokens', (target.output_tokens ?? 0) + (usage.output_tokens ?? 0));
    setTokenUsageField(target, 'cache_creation_input_tokens', (target.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0));
    setTokenUsageField(target, 'cache_read_input_tokens', (target.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0));
}

function setTokenUsageField(target: TokenUsage, key: keyof TokenUsage, value: number): void {
    if (value > 0) {
        target[key] = value;
    } else {
        delete target[key];
    }
}

export function hasOpenCodeTokenUsage(usage: TokenUsage | NormalizedOpenCodeUsage): boolean {
    return Boolean(
        usage.input_tokens
        || usage.output_tokens
        || usage.cache_creation_input_tokens
        || usage.cache_read_input_tokens
    );
}

function hasOpenCodeTextField(event: { text?: unknown; content?: unknown; delta?: unknown }): boolean {
    return typeof event.text === 'string' || typeof event.content === 'string' || typeof event.delta === 'string';
}

function buildOpenCodeSummary(state: OpenCodeParseState): string | undefined {
    const lastAssistantMessage = state.assistantMessages.at(-1)?.trim();
    if (lastAssistantMessage) return lastAssistantMessage;
    return state.streamTextParts.join('').trim() || undefined;
}

function extractOpenCodeText(event: OpenCodeEvent): ExtractedOpenCodeText {
    if (event.message?.role && event.message.role !== 'assistant') {
        return { streamParts: [] };
    }
    const streamParts: string[] = [];
    const messageParts: string[] = [];
    addPartText(streamParts, event.part);
    addPartsText(streamParts, event.parts);
    const hasEventParts = Boolean(event.part || event.parts?.length);
    const assistantMessage = event.message?.role === 'assistant' ? event.message : undefined;
    if (assistantMessage) {
        if (assistantMessage.parts?.length) {
            addPartsText(messageParts, assistantMessage.parts);
        } else {
            addTextContainer(messageParts, assistantMessage);
        }
    }
    if (!hasEventParts && !assistantMessage && (isAssistantTextEvent(event) || event.response)) {
        addTextContainer(streamParts, event);
        addTextContainer(streamParts, event.response);
    }
    return {
        streamParts,
        assistantMessage: messageParts.join('') || undefined
    };
}

function addPartsText(textParts: string[], parts?: OpenCodePart[]): void {
    for (const part of parts || []) addPartText(textParts, part);
}

function addPartText(textParts: string[], part?: OpenCodePart): void {
    if (!part) return;
    const partType = part.type?.toLowerCase();
    if (partType && !['text', 'assistant_text', 'message', 'completion', 'reasoning'].includes(partType)) return;
    addTextContainer(textParts, part);
}

function addTextContainer(textParts: string[], container?: OpenCodeTextContainer): void {
    if (!container) return;
    const valuesAdded = new Set<string>();
    for (const value of [container.text, container.delta, container.content]) {
        if (typeof value === 'string' && value.length > 0 && !valuesAdded.has(value)) {
            valuesAdded.add(value);
            textParts.push(value);
        }
    }
}

function isAssistantTextEvent(event: OpenCodeEvent): boolean {
    const type = event.type?.toLowerCase();
    return !!type && ['text', 'assistant', 'message', 'delta', 'completion', 'reasoning'].includes(type);
}

function extractOpenCodeError(event: OpenCodeEvent): string {
    if (typeof event.error === 'string') return event.error;
    return event.error?.data?.message || event.error?.message || event.error?.name || 'OpenCode execution failed';
}

function buildOpenCodeContainerName(alias: string, taskType: string, shortTaskId: string, modelName?: string): string {
    const rawName = modelName
        ? `${alias}-${taskType}-${modelName}-${shortTaskId}`
        : `${alias}-${taskType}-${shortTaskId}`;
    const sanitized = rawName.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 120);
    return sanitized || `opencode-${Date.now().toString(36)}`;
}

function ensureDirectory(configPath: string): void {
    fs.mkdirSync(configPath, { recursive: true, mode: 0o700 });
}
