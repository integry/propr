import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    getDockerRunContainerName,
    getExecutionAbortError,
    getExecutionOwnershipContext,
    resolveExecutionArgs,
} from '../../claude/docker/dockerExecutionOwnership.js';
import type { AgentConfig, AgentExecutionResult, AgentTaskOptions } from '../types.js';
import { AppServerConnection, asRecord, type RpcMessage } from './codexAppServerConnection.js';
import { buildCodexAppServerDockerArgs } from './utils/codexDockerArgsBuilder.js';

const execFileAsync = promisify(execFile);

interface ThreadIdentity {
    id: string;
    sessionId: string;
    model?: string;
}

interface GoalProtocolResult {
    thread: ThreadIdentity;
    completion?: { status: string; error?: string };
    effectiveModel?: string;
}

interface NativeGoalSnapshot {
    status: string;
    objective?: string;
}

function cleanModelName(model: string | undefined): string | undefined {
    return model?.includes(':') ? model.split(':').pop() : model;
}

function extractThread(result: Record<string, unknown>, fallbackSessionId?: string): ThreadIdentity {
    const thread = asRecord(result.thread);
    if (typeof thread.id !== 'string') throw new Error('Codex App Server did not return thread.id');
    const sessionId = typeof thread.sessionId === 'string' ? thread.sessionId : fallbackSessionId;
    if (!sessionId) throw new Error('Codex App Server did not return thread.sessionId');
    return {
        id: thread.id,
        sessionId,
        ...(typeof result.model === 'string' ? { model: result.model } : {}),
    };
}

function turnStatus(message: RpcMessage): { status: string; error?: string } {
    if (message.error) return { status: 'failed', error: message.error.message };
    const turn = asRecord(message.params?.turn);
    const error = asRecord(turn.error);
    return {
        status: typeof turn.status === 'string' ? turn.status : 'failed',
        ...(typeof error.message === 'string' ? { error: error.message } : {}),
    };
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

async function openGoalThread(
    connection: AppServerConnection,
    options: AgentTaskOptions,
    model: string | undefined,
): Promise<ThreadIdentity> {
    await connection.request('initialize', { clientInfo: { name: 'propr', title: 'ProPR', version: '1' } });
    connection.notify('initialized');
    const result = options.resumeSessionId
        ? await connection.request('thread/resume', { threadId: options.resumeSessionId, ...(model ? { model } : {}) })
        : await connection.request('thread/start', {
            ...(model ? { model } : {}), cwd: '/home/node/workspace', approvalPolicy: 'never',
            sandbox: 'danger-full-access', serviceName: 'propr',
        });
    const thread = extractThread(result, options.resumeConversationId);
    if (options.resumeSessionId && thread.id !== options.resumeSessionId) {
        throw new Error('Codex App Server resumed a different thread than the persisted goal identity');
    }
    connection.effectiveModel = thread.model ?? model;
    await options.onSessionId?.(thread.id, thread.sessionId);
    if (options.resumeSessionId) {
        await connection.request('thread/goal/get', { threadId: thread.id });
    } else {
        await connection.request('thread/goal/set', {
            threadId: thread.id,
            objective: options.nativeGoalObjective,
            status: 'active',
        });
    }
    return thread;
}

function nativeGoalSnapshot(result: Record<string, unknown>): NativeGoalSnapshot {
    const goal = asRecord(result.goal);
    if (typeof goal.status !== 'string') throw new Error('Codex App Server did not return the native goal status');
    return {
        status: goal.status,
        ...(typeof goal.objective === 'string' ? { objective: goal.objective } : {}),
    };
}

async function waitForNativeGoalTurn(
    connection: AppServerConnection,
    threadId: string,
    control: NonNullable<AgentTaskOptions['goalControl']>,
): Promise<string | null> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const turnId = connection.takeStartedTurn(threadId);
        if (turnId) return turnId;
        if (connection.closeError) throw connection.closeError;
        await control.heartbeat();
        if ((await control.load()).desiredState !== 'running') return null;
        await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error('Codex App Server goal remained active without starting its next native turn');
}

async function observeNativeGoal(
    connection: AppServerConnection,
    threadId: string,
    initialTurnId: string,
    options: AgentTaskOptions,
): Promise<{ status: string; error?: string }> {
    const control = options.goalControl!;
    let turnId = initialTurnId;
    let firstTurn = true;
    while (true) {
        connection.discardStartedTurn(turnId);
        await control.setActiveTurn(turnId);
        if (firstTurn && options.initialControlInputId) {
            await control.markInputDelivered(options.initialControlInputId, turnId);
        }
        firstTurn = false;
        const completion = await observeActiveTurnWithThread(connection, threadId, turnId, control);
        await control.setActiveTurn(null);
        if (completion.status !== 'completed') return completion;
        if ((await control.load()).desiredState !== 'running') {
            return { status: 'interrupted', error: 'Goal stopped at a provider turn boundary' };
        }
        const goal = nativeGoalSnapshot(await connection.request('thread/goal/get', { threadId }));
        if (goal.status === 'complete') return completion;
        if (goal.status !== 'active') {
            return { status: 'failed', error: `Codex native goal entered ${goal.status} status` };
        }
        const nextTurnId = await waitForNativeGoalTurn(connection, threadId, control);
        if (!nextTurnId) return { status: 'interrupted', error: 'Goal stopped between provider turns' };
        turnId = nextTurnId;
    }
}

async function runGoalProtocol(
    connection: AppServerConnection,
    options: AgentTaskOptions,
    model: string | undefined,
): Promise<GoalProtocolResult> {
    const control = options.goalControl!;
    const thread = await openGoalThread(connection, options, model);
    if (options.resumeSessionId) {
        const recoveredGoal = nativeGoalSnapshot(await connection.request('thread/goal/get', { threadId: thread.id }));
        if (recoveredGoal.objective !== options.nativeGoalObjective) {
            throw new Error('Persisted Codex thread belongs to a different native goal objective');
        }
        if (recoveredGoal.status === 'complete') {
            return { thread, completion: { status: 'completed' }, effectiveModel: model };
        }
        if (recoveredGoal.status !== 'active') {
            return {
                thread,
                completion: { status: 'failed', error: `Codex native goal resumed in ${recoveredGoal.status} status` },
                effectiveModel: model,
            };
        }
    }
    const boundary = await control.load();
    if (boundary.desiredState !== 'running') {
        return { thread, effectiveModel: cleanModelName(boundary.requestedModel) || model };
    }
    const effectiveModel = cleanModelName(boundary.requestedModel) || model;
    const result = await connection.request('turn/start', {
        threadId: thread.id,
        ...(options.initialControlInputId ? { clientUserMessageId: options.initialControlInputId } : {}),
        input: [{ type: 'text', text: options.prompt, text_elements: [] }],
        ...(effectiveModel ? { model: effectiveModel } : {}),
    });
    const turn = asRecord(result.turn);
    if (typeof turn.id !== 'string') throw new Error('Codex App Server did not return turn.id');
    connection.effectiveModel = typeof turn.model === 'string' ? turn.model : effectiveModel;
    const completion = await observeNativeGoal(connection, thread.id, turn.id, options);
    await connection.request('thread/goal/get', { threadId: thread.id }).catch(() => undefined);
    return { thread, completion, effectiveModel };
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
        summary: connection.summaryParts.join('\n\n') || undefined,
        modifiedFiles: [],
        modelUsed: connection.effectiveModel || effectiveModel || 'unknown',
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
    const connection = new AppServerConnection(child, options.taskId);
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
            modifiedFiles: [], modelUsed: connection.effectiveModel || model || 'unknown',
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

async function observeActiveTurnWithThread(
    connection: AppServerConnection,
    threadId: string,
    turnId: string,
    control: NonNullable<AgentTaskOptions['goalControl']>,
): Promise<{ status: string; error?: string }> {
    let completed: RpcMessage | null = null;
    const completion = connection.waitForTurn(turnId).then(message => { completed = message; });
    let interrupted = false;
    while (!completed) {
        await Promise.race([completion, new Promise(resolve => setTimeout(resolve, 400))]);
        if (completed) break;
        await control.heartbeat();
        const snapshot = await control.load();
        if (snapshot.desiredState !== 'running') {
            if (!interrupted) {
                interrupted = true;
                await connection.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
            }
            continue;
        }
        for (const input of snapshot.pendingInputs) {
            await connection.request('turn/steer', {
                threadId,
                clientUserMessageId: input.id,
                input: [{ type: 'text', text: input.message, text_elements: [] }],
                expectedTurnId: turnId,
            });
            await control.markInputDelivered(input.id, turnId);
        }
    }
    return turnStatus(completed!);
}
