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
    GoalCheckpointRequest,
} from '../types.js';
import { AppServerConnection, asRecord, type RpcMessage } from './codexAppServerConnection.js';
import { buildCodexAppServerDockerArgs } from './utils/codexDockerArgsBuilder.js';

const execFileAsync = promisify(execFile);
export const CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS = 5 * 60 * 1000;

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

function nativeGoalObjective(options: AgentTaskOptions): string {
    return options.nativeGoalObjective!;
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
        ...(typeof thread.model === 'string'
            ? { model: thread.model }
            : typeof result.model === 'string' ? { model: result.model } : {}),
    };
}

interface TurnCompletion {
    status: string;
    error?: string;
    checkpoint?: GoalCheckpointRequest;
}

function turnStatus(message: RpcMessage): TurnCompletion {
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
    // The request is buffered while the repository setup hook and container
    // entrypoint run. Large repositories can legitimately take longer than the
    // ordinary RPC timeout before App Server begins consuming stdin.
    await connection.request(
        'initialize',
        { clientInfo: { name: 'propr', title: 'ProPR', version: '1' } },
        CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
    );
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
    connection.effectiveModel = thread.model;
    if (!options.resumeSessionId) {
        // Materialize the immutable objective without starting work, then make
        // the exact thread identity durable. A crash can now reopen a real goal
        // instead of publishing an empty thread that cannot be recovered.
        await connection.request('thread/goal/set', {
            threadId: thread.id,
            objective: nativeGoalObjective(options),
            status: 'paused',
        });
    }
    await options.onSessionId?.(thread.id, thread.sessionId);
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
    objective: string,
): Promise<string | null> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const turnId = connection.takeStartedTurn(threadId);
        if (turnId) return turnId;
        if (connection.closeError) throw connection.closeError;
        await control.heartbeat();
        const desiredState = (await control.load()).desiredState;
        if (desiredState !== 'running') {
            await applyNativeGoalStop(connection, { threadId, desiredState, objective });
            return null;
        }
        await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error('Codex App Server goal remained active without starting its next native turn');
}

async function applyNativeGoalStop(
    connection: AppServerConnection,
    options: {
        threadId: string;
        desiredState: 'paused' | 'cancelled';
        objective: string;
        turnId?: string;
    },
): Promise<void> {
    const { threadId, desiredState, objective, turnId } = options;
    if (desiredState === 'cancelled') {
        await connection.request('thread/goal/clear', { threadId });
    } else {
        await connection.request('thread/goal/set', { threadId, objective, status: 'paused' });
    }
    if (turnId) await connection.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
}

async function observeNativeGoal(
    connection: AppServerConnection,
    threadId: string,
    initialTurnId: string,
    options: AgentTaskOptions,
): Promise<{ status: string; error?: string }> {
    const control = options.goalControl!;
    const objective = nativeGoalObjective(options);
    let turnId = initialTurnId;
    let firstTurn = true;
    while (true) {
        connection.discardStartedTurn(turnId);
        await control.setActiveTurn(turnId);
        if (firstTurn && options.initialControlInputId) {
            await connection.request('turn/steer', {
                threadId,
                clientUserMessageId: options.initialControlInputId,
                input: [{ type: 'text', text: options.prompt, text_elements: [] }],
                expectedTurnId: turnId,
            });
            await control.markInputDelivered(options.initialControlInputId, turnId);
        }
        firstTurn = false;
        const completion = await observeActiveTurnWithThread(connection, threadId, turnId, options);
        await control.setActiveTurn(null);
        if (completion.status !== 'completed') return completion;
        let boundary = await control.load();
        const checkpoint = completion.checkpoint ?? boundary.checkpoint;
        let completedDuringCheckpoint = false;
        if (checkpoint) {
            if (!completion.checkpoint) {
                await connection.request('thread/goal/set', {
                    threadId, objective, status: 'paused',
                });
            }
            await control.publishCheckpoint(checkpoint, turnId);
            boundary = await control.load();
            const nativeBoundary = nativeGoalSnapshot(await connection.request('thread/goal/get', { threadId }));
            completedDuringCheckpoint = nativeBoundary.status === 'complete';
            if (boundary.desiredState === 'running' && nativeBoundary.status === 'paused') {
                await connection.request('thread/goal/set', {
                    threadId, objective, status: 'active',
                });
            }
        }
        const desiredState = boundary.desiredState;
        if (desiredState !== 'running') {
            await applyNativeGoalStop(connection, { threadId, desiredState, objective });
            return { status: 'interrupted', error: 'Goal stopped at a provider turn boundary' };
        }
        if (completedDuringCheckpoint) return completion;
        const goal = nativeGoalSnapshot(await connection.request('thread/goal/get', { threadId }));
        if (goal.status === 'complete') return completion;
        if (goal.status !== 'active') {
            return { status: 'failed', error: `Codex native goal entered ${goal.status} status` };
        }
        const nextTurnId = await waitForNativeGoalTurn(connection, threadId, control, objective);
        if (!nextTurnId) return { status: 'interrupted', error: 'Goal stopped between provider turns' };
        turnId = nextTurnId;
    }
}

export async function runGoalProtocol(
    connection: AppServerConnection,
    options: AgentTaskOptions,
    model: string | undefined,
): Promise<GoalProtocolResult> {
    const control = options.goalControl!;
    const thread = await openGoalThread(connection, options, model);
    if (options.resumeSessionId) {
        const recoveredGoal = nativeGoalSnapshot(await connection.request('thread/goal/get', { threadId: thread.id }));
        if (recoveredGoal.objective !== nativeGoalObjective(options)) {
            throw new Error('Persisted Codex thread belongs to a different native goal objective');
        }
        if (recoveredGoal.status === 'complete') {
            if (options.initialControlInputId) {
                await control.markInputUndeliverable(
                    options.initialControlInputId,
                    'Codex native goal completed before this FIFO input could be delivered',
                );
            }
            return { thread, completion: { status: 'completed' }, effectiveModel: thread.model };
        }
        if (['paused', 'blocked', 'usageLimited'].includes(recoveredGoal.status)) {
            await connection.request('thread/goal/set', {
                threadId: thread.id,
                objective: nativeGoalObjective(options),
                status: 'active',
            });
        } else if (recoveredGoal.status !== 'active') {
            return {
                thread,
                completion: { status: 'failed', error: `Codex native goal resumed in ${recoveredGoal.status} status` },
                effectiveModel: thread.model,
            };
        }
    }
    const boundary = await control.load();
    if (boundary.desiredState !== 'running') {
        const startedTurnId = connection.takeStartedTurn(thread.id) ?? undefined;
        await applyNativeGoalStop(connection, {
            threadId: thread.id,
            desiredState: boundary.desiredState,
            objective: nativeGoalObjective(options),
            ...(startedTurnId ? { turnId: startedTurnId } : {}),
        });
        return {
            thread,
            completion: { status: 'interrupted', error: 'Goal stopped before provider turn observation' },
            effectiveModel: thread.model,
        };
    }
    if (!options.resumeSessionId) {
        // App Server 0.146 activates the external goal and continues the thread
        // itself. Activate once only after identity persistence and the final
        // desired-state check above.
        await connection.request('thread/goal/set', {
            threadId: thread.id,
            objective: nativeGoalObjective(options),
            status: 'active',
        });
    }
    const effectiveModel = thread.model;
    // Applying/resuming an active external goal calls continue_if_idle() in the
    // pinned App Server. Starting another turn here races that native turn.
    const turnId = await waitForNativeGoalTurn(connection, thread.id, control, nativeGoalObjective(options));
    if (!turnId) return { thread, effectiveModel };
    const completion = await observeNativeGoal(connection, thread.id, turnId, options);
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

async function observeActiveTurnWithThread(
    connection: AppServerConnection,
    threadId: string,
    turnId: string,
    options: AgentTaskOptions,
): Promise<TurnCompletion> {
    const control = options.goalControl!;
    const objective = nativeGoalObjective(options);
    let completed: RpcMessage | null = null;
    const completion = connection.waitForTurn(turnId).then(message => { completed = message; });
    let interrupted = false;
    let checkpoint: GoalCheckpointRequest | undefined;
    while (!completed) {
        await Promise.race([completion, new Promise(resolve => setTimeout(resolve, 400))]);
        if (completed) break;
        await control.heartbeat();
        const snapshot = await control.load();
        if (snapshot.desiredState !== 'running') {
            if (!interrupted) {
                interrupted = true;
                await applyNativeGoalStop(connection, {
                    threadId, desiredState: snapshot.desiredState, objective, turnId,
                });
            }
            continue;
        }
        if (!checkpoint && snapshot.checkpoint) {
            checkpoint = snapshot.checkpoint;
            // Pausing the external goal does not interrupt the current turn. It
            // prevents native auto-continuation from racing the worker's git
            // checkpoint after this turn reaches its safe boundary.
            await connection.request('thread/goal/set', {
                threadId, objective, status: 'paused',
            });
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
    return { ...turnStatus(completed!), ...(checkpoint ? { checkpoint } : {}) };
}
