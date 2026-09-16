import fs from 'node:fs';
import path from 'node:path';
import logger from '../../utils/logger.js';
import { resolveConfigPath } from '../../config/configManager.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../claude/docker/repoSetupWrapper.js';
import { generateClaudePrompt, type IssueDetails, type IssueRef } from '../../claude/prompts/promptGenerator.js';
import { CONTAINER_CONFIG_PATHS, type AgentConfig } from '../types.js';
import { buildEnvironmentVariableArgs } from './utils/dockerArgsBuilder.js';
import { createContainerExecutionId } from './utils/containerExecutionId.js';

const CONTAINER_WORKSPACE = '/home/node/workspace';

export interface ParsedMuseOutput {
    text?: string;
    model?: string;
    sessionId?: string;
    error?: string;
    completed: boolean;
    conversationLog: Array<Record<string, unknown>>;
}

interface MuseEvent {
    stream?: { kind?: string; id?: string };
    payload_type?: string;
    payload?: Record<string, unknown>;
}

function parseMuseEvents(output: string): MuseEvent[] {
    const events: MuseEvent[] = [];
    for (const line of output.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
            const parsed = JSON.parse(line) as MuseEvent;
            if (parsed && typeof parsed === 'object') events.push(parsed);
        } catch {
            // Muse writes diagnostics to stderr, but tolerate non-JSON stdout lines.
        }
    }
    return events;
}

function payloadString(event: MuseEvent | undefined, key: string): string | undefined {
    const value = event?.payload?.[key];
    return typeof value === 'string' ? value : undefined;
}

function lastMatchingEvent(events: MuseEvent[], predicate: (event: MuseEvent) => boolean): MuseEvent | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index]!)) return events[index];
    }
    return undefined;
}

function failedTaskReason(event: MuseEvent | undefined): string | undefined {
    const taskEvent = event?.payload?.event;
    return taskEvent && typeof taskEvent === 'object' && typeof (taskEvent as { reason?: unknown }).reason === 'string'
        ? (taskEvent as { reason: string }).reason
        : undefined;
}

export function parseMuseJsonl(output: string, prompt?: string): ParsedMuseOutput {
    const events = parseMuseEvents(output);
    const terminal = lastMatchingEvent(events, event => Boolean(event.payload_type?.startsWith('run.terminal.')));
    const configured = lastMatchingEvent(events, event => event.payload_type === 'run.model.configured');
    const failedTask = lastMatchingEvent(events, event => event.payload_type === 'task.lifecycle.failed');
    const terminalText = payloadString(terminal, 'text')?.trim() || '';
    const completed = terminal?.payload_type === 'run.terminal.completed'
        && payloadString(terminal, 'terminal') === 'completed'
        && terminalText.length > 0;
    const conversationLog: Array<Record<string, unknown>> = [];
    if (prompt) conversationLog.push({ type: 'user', message: { content: [{ type: 'text', text: prompt }] } });
    if (terminalText) conversationLog.push({ type: 'assistant', message: { content: [{ type: 'text', text: terminalText }] } });

    return {
        text: terminalText || undefined,
        model: payloadString(configured, 'model_id'),
        sessionId: events.find(event => event.stream?.kind === 'session')?.stream?.id,
        error: completed ? undefined : (
            payloadString(terminal, 'reason')
            || failedTaskReason(failedTask)
            || 'Muse did not emit a completed terminal response'
        ),
        completed,
        conversationLog,
    };
}

export function buildMusePrompt(options: {
    customPrompt?: string;
    issueRef: IssueRef;
    branchName?: string;
    modelName?: string;
    issueDetails?: IssueDetails;
    isRetry?: boolean;
    retryReason?: string;
    systemPrompt?: string;
}): string {
    const base = options.customPrompt || generateClaudePrompt({
        issueRef: options.issueRef,
        branchName: options.branchName ?? null,
        modelName: options.modelName ?? null,
        issueDetails: options.issueDetails ?? null,
    });
    const system = options.systemPrompt ? `SYSTEM INSTRUCTIONS:\n${options.systemPrompt}\n\n---\n\n` : '';
    const retry = options.isRetry && options.retryReason
        ? `\n\n---\n\nRETRY CONTEXT: The previous attempt failed with: ${options.retryReason}\nAddress that failure in this attempt.`
        : '';
    return `${system}${base}${retry}`;
}

export interface MuseDockerArgsParams {
    worktreePath: string;
    githubToken: string;
    modelName: string;
    issueNumber: number;
    taskId?: string;
    executionType?: string;
    reasoningLevel?: string;
    environment?: Record<string, string>;
    maxModelSteps: number;
    readOnlyWorkspace?: boolean;
    allowReadOnlyCommands?: boolean;
}

export function buildMuseDockerArgs(config: AgentConfig, params: MuseDockerArgsParams): string[] {
    const {
        worktreePath, githubToken, modelName, issueNumber, taskId, executionType,
        reasoningLevel, environment, maxModelSteps, readOnlyWorkspace = false,
        allowReadOnlyCommands = false,
    } = params;
    const configPath = resolveConfigPath(config.configPath);
    const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
    const containerName = `${config.alias || 'muse'}-${taskType}-${createContainerExecutionId(taskId)}`
        .replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 128);
    const cleanModel = modelName.includes(':') ? modelName.split(':').pop()! : modelName;
    const envVars = buildEnvironmentVariableArgs([config.envVars, environment], readOnlyWorkspace);
    const args = [
        'run', '--rm', '-i', '--name', containerName,
        '--security-opt', 'no-new-privileges', '--cap-add', 'CHOWN', '--network', 'bridge', '--user', '0:0',
        '-v', `${worktreePath}:${CONTAINER_WORKSPACE}:${readOnlyWorkspace ? 'ro' : 'rw'}`,
        ...(readOnlyWorkspace ? [] : ['-v', '/tmp/git-processor:/tmp/git-processor:rw']),
        '-v', `${configPath}:${CONTAINER_CONFIG_PATHS.muse}:rw`,
        ...(readOnlyWorkspace ? ['-e', 'PROPR_REPO_SETUP=0'] : ['-e', `GH_TOKEN=${githubToken}`]),
        ...envVars,
        '-w', CONTAINER_WORKSPACE,
        config.dockerImage,
        'muse-run', '--json', '--no-session-log', '--no-foreign-personal-context', '--user-input-auto-resolve',
        '--yolo', '--max-model-steps', String(maxModelSteps), '--model', cleanModel,
        ...(reasoningLevel ? ['--reasoning-effort', reasoningLevel] : []),
        ...(readOnlyWorkspace ? ['--disable-write'] : []),
        ...(readOnlyWorkspace && !allowReadOnlyCommands ? ['--disable-shell'] : []),
    ];
    logger.info({ issueNumber, requestedModel: cleanModel, reasoningLevel, agentAlias: config.alias }, 'Docker args built for Muse Code agent');
    return wrapDockerRunArgsWithRepoSetup(args, config.dockerImage, 'muse');
}

export function ensureMuseAnalysisWorkspace(): string {
    const root = process.env.MUSE_ANALYSIS_ROOT || '/tmp/git-processor';
    fs.mkdirSync(root, { recursive: true, mode: 0o755 });
    const workspace = fs.mkdtempSync(path.join(root, 'muse-analysis-'));
    // mkdtempSync creates the directory 0700 owned by the API process (root).
    // The Muse container runs as the unprivileged `node` user and must be able
    // to read the read-only workspace mount, so relax it like Vibe does.
    try {
        fs.chmodSync(workspace, 0o755);
    } catch { /* best-effort */ }
    return workspace;
}

export function cleanupMuseAnalysisWorkspace(workspace: string | undefined): void {
    if (!workspace) return;
    const root = path.resolve(process.env.MUSE_ANALYSIS_ROOT || '/tmp/git-processor');
    const resolved = path.resolve(workspace);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* best effort */ }
}
