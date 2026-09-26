import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    getDockerRunContainerName,
    getExecutionAbortError,
    getExecutionOwnershipContext,
    resolveExecutionArgs,
} from '../../claude/docker/dockerExecutionOwnership.js';
import type {
    AgentConfig,
    AgentExecutionResult,
    AgentTaskOptions,
} from '../types.js';
import { AppServerConnection } from './codexAppServerConnection.js';
import {
    runGoalProtocol,
    type GoalProtocolResult,
    type ThreadIdentity,
} from './codexAppServerGoalProtocol.js';
import { buildCodexAppServerDockerArgs } from './utils/codexDockerArgsBuilder.js';

export { CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS, runGoalProtocol } from './codexAppServerGoalProtocol.js';

const execFileAsync = promisify(execFile);

function cleanModelName(model: string | undefined): string | undefined {
    return model?.includes(':') ? model.split(':').pop() : model;
}

async function detectContainer(
    containerName: string | null,
    callback: AgentTaskOptions['onContainerId'],
): Promise<void> {
    if (!containerName || !callback) return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{.Id}}', containerName]);
            const id = stdout.trim();
            if (id) return void await callback(id, containerName);
        } catch { /* container creation may still be in progress */ }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

function protocolResult(
    connection: AppServerConnection,
    protocol: GoalProtocolResult,
    start: number,
): AgentExecutionResult {
    const { thread, completion, effectiveModel } = protocol;
    const success = completion?.status === 'completed';
    return {
        success,
        logs: `${connection.rawOutput}${connection.stderrOutput ? `\n${connection.stderrOutput}` : ''}`,
        rawOutput: connection.rawOutput,
        conversationLog: connection.conversationLog,
        summary: connection.summaryParts.join('\n\n') || undefined,
        modifiedFiles: [],
        modelUsed: connection.effectiveModel || effectiveModel || 'unknown',
        providerModel: connection.effectiveModel || effectiveModel,
        sessionId: thread.id,
        conversationId: thread.sessionId,
        executionTimeMs: Date.now() - start,
        tokenUsage: connection.tokenUsage,
        exitCode: 0,
        ...(!success ? { error: completion?.error || (completion ? `Codex turn ${completion.status}` : 'Goal paused before turn start') } : {}),
    };
}

export async function executeCodexAppServerGoal(
    config: AgentConfig,
    options: AgentTaskOptions,
    timeoutMs: number,
): Promise<AgentExecutionResult> {
    const start = Date.now();
    const model = cleanModelName(options.model || config.defaultModel);
    const control = options.goalControl;
    if (!control || !options.nativeGoalObjective) throw new Error('Codex native goal execution requires durable goal controls and an objective');
    const dockerArgs = buildCodexAppServerDockerArgs(config, {
        worktreePath: options.worktreePath,
        githubToken: options.githubToken,
        issueNumber: options.issueRef.number,
        environment: options.environment,
        taskId: options.taskId,
    });
    const ownership = getExecutionOwnershipContext();
    const args = resolveExecutionArgs('docker', dockerArgs, options.taskId, ownership?.attemptGeneration);
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: options.worktreePath });
    const abort = (): void => { child.kill('SIGTERM'); };
    ownership?.signal.addEventListener('abort', abort, { once: true });
    const connection = new AppServerConnection(child, options.taskId, records => control.appendOutput(records));
    void detectContainer(getDockerRunContainerName(args), options.onContainerId);
    const deadline = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    let thread: ThreadIdentity | undefined;
    try {
        const protocol = await runGoalProtocol(connection, options, model);
        thread = protocol.thread;
        return protocolResult(connection, protocol, start);
    } catch (error) {
        const abortError = getExecutionAbortError(ownership?.signal);
        const message = (abortError ?? error as Error).message;
        return {
            success: false,
            logs: `${connection.rawOutput}${connection.stderrOutput ? `\n${connection.stderrOutput}` : ''}`,
            rawOutput: connection.rawOutput,
            conversationLog: connection.conversationLog,
            modifiedFiles: [], modelUsed: connection.effectiveModel || thread?.model || 'unknown',
            providerModel: connection.effectiveModel || thread?.model,
            sessionId: thread?.id, conversationId: thread?.sessionId,
            executionTimeMs: Date.now() - start, error: message, exitCode: child.exitCode,
        };
    } finally {
        clearTimeout(deadline);
        ownership?.signal.removeEventListener('abort', abort);
        await control.setActiveTurn(null).catch(() => undefined);
        await connection.close();
    }
}
