import { randomUUID } from 'node:crypto';
import { parseGoalCheckpointDeclaration } from '../../goals.js';
import type {
    AgentTaskOptions,
    GoalCheckpointRequest,
    GoalCheckpointRejection,
    GoalControlSnapshot,
} from '../types.js';
import { AppServerConnection, asRecord, type RpcMessage } from './codexAppServerConnection.js';

export const CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS = 5 * 60 * 1000;

export interface ThreadIdentity {
    id: string;
    sessionId: string;
    model?: string;
}

export interface GoalProtocolResult {
    thread: ThreadIdentity;
    completion?: { status: string; error?: string };
    effectiveModel?: string;
}

interface NativeGoalSnapshot {
    status: string;
    objective?: string;
}

interface TurnCompletion {
    status: string;
    error?: string;
    checkpoint?: GoalCheckpointRequest;
    checkpointRejection?: GoalCheckpointRejection;
}

interface CheckpointBoundary {
    boundary: GoalControlSnapshot;
    completedDuringCheckpoint: boolean;
    checkpointFeedback?: string;
}

function nativeGoalObjective(options: AgentTaskOptions): string {
    return options.nativeGoalObjective!;
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

function checkpointAcknowledgement(commitSha: string | null | undefined): string {
    return commitSha
        ? `ProPR accepted and published your checkpoint as commit ${commitSha}. Continue working toward the goal.`
        : 'ProPR accepted your checkpoint, but there were no matching changes to commit. Continue working toward the goal.';
}

function checkpointRejection(error: string): string {
    return `ProPR rejected your checkpoint declaration: ${error}. No checkpoint was committed. Correct the declaration and continue working toward the goal.`;
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

async function steerInitialGoalInput(
    connection: AppServerConnection,
    threadId: string,
    turnId: string,
    options: AgentTaskOptions,
): Promise<void> {
    if (!options.initialControlInputId && !options.initialGoalFeedback) return;
    await connection.request('turn/steer', {
        threadId,
        clientUserMessageId: options.initialControlInputId ?? randomUUID(),
        input: [{
            type: 'text',
            text: options.initialGoalFeedback ?? options.initialControlInputMessage ?? options.prompt,
            text_elements: [],
        }],
        expectedTurnId: turnId,
    });
    if (options.initialControlInputId) {
        await options.goalControl!.markInputDelivered(options.initialControlInputId, turnId);
    }
}

async function processCheckpointBoundary(
    connection: AppServerConnection,
    completion: TurnCompletion,
    options: { threadId: string; turnId: string; objective: string; control: NonNullable<AgentTaskOptions['goalControl']> },
): Promise<CheckpointBoundary> {
    const { threadId, turnId, objective, control } = options;
    let boundary = await control.load();
    let completedDuringCheckpoint = false;
    let checkpointFeedback: string | undefined;
    if (completion.checkpoint) {
        await connection.request('thread/goal/set', { threadId, objective, status: 'paused' });
        const outcome = await control.publishCheckpoint(completion.checkpoint, turnId);
        checkpointFeedback = outcome.accepted
            ? checkpointAcknowledgement(outcome.commitSha)
            : checkpointRejection(outcome.error || 'The declaration could not be published');
        boundary = await control.load();
        const nativeBoundary = nativeGoalSnapshot(await connection.request('thread/goal/get', { threadId }));
        completedDuringCheckpoint = nativeBoundary.status === 'complete';
        if (boundary.desiredState === 'running' && nativeBoundary.status === 'paused') {
            await connection.request('thread/goal/set', { threadId, objective, status: 'active' });
        }
    } else if (completion.checkpointRejection) {
        await control.rejectCheckpoint(completion.checkpointRejection, turnId);
        checkpointFeedback = checkpointRejection(completion.checkpointRejection.error);
        boundary = await control.load();
    }
    return { boundary, completedDuringCheckpoint, ...(checkpointFeedback ? { checkpointFeedback } : {}) };
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
        if (firstTurn) await steerInitialGoalInput(connection, threadId, turnId, options);
        firstTurn = false;
        const completion = await observeActiveTurnWithThread(connection, threadId, turnId, options);
        await control.setActiveTurn(null);
        if (completion.status !== 'completed') return completion;
        const { boundary, completedDuringCheckpoint, checkpointFeedback } = await processCheckpointBoundary(
            connection,
            completion,
            { threadId, turnId, objective, control },
        );
        const desiredState = boundary.desiredState;
        if (desiredState !== 'running') {
            await applyNativeGoalStop(connection, { threadId, desiredState, objective });
            return { status: 'interrupted', error: 'Goal stopped at a provider turn boundary' };
        }
        if (completedDuringCheckpoint) return completion;
        const goal = checkpointFeedback
            ? { status: 'active' }
            : nativeGoalSnapshot(await connection.request('thread/goal/get', { threadId }));
        if (goal.status === 'complete') return completion;
        if (goal.status !== 'active') {
            return { status: 'failed', error: `Codex native goal entered ${goal.status} status` };
        }
        const nextTurnId = await waitForNativeGoalTurn(connection, threadId, control, objective);
        if (!nextTurnId) return { status: 'interrupted', error: 'Goal stopped between provider turns' };
        if (checkpointFeedback) {
            await connection.request('turn/steer', {
                threadId,
                clientUserMessageId: randomUUID(),
                input: [{ type: 'text', text: checkpointFeedback, text_elements: [] }],
                expectedTurnId: nextTurnId,
            });
        }
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

async function observeActiveTurnWithThread(
    connection: AppServerConnection,
    threadId: string,
    turnId: string,
    options: AgentTaskOptions,
): Promise<TurnCompletion> {
    const control = options.goalControl!;
    const objective = nativeGoalObjective(options);
    let completed: RpcMessage | null = null;
    const summaryStart = connection.agentMessageCursor;
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
                await applyNativeGoalStop(connection, {
                    threadId, desiredState: snapshot.desiredState, objective, turnId,
                });
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
    const declaration = parseGoalCheckpointDeclaration(connection.agentMessagesAfter(summaryStart).join('\n'));
    const checkpointRejectionRequest: GoalCheckpointRejection | undefined = declaration && 'rejected' in declaration ? {
        kind: 'agent',
        error: declaration.error,
        commitMessage: declaration.message,
        include: declaration.include,
        exclude: declaration.exclude,
        summary: declaration.summary,
    } : undefined;
    const checkpoint: GoalCheckpointRequest | undefined = declaration && !('rejected' in declaration) ? {
        kind: 'agent',
        commitMessage: declaration.message,
        include: declaration.include,
        exclude: declaration.exclude,
        summary: declaration.summary,
    } : undefined;
    return {
        ...turnStatus(completed!),
        ...(checkpoint ? { checkpoint } : {}),
        ...(checkpointRejectionRequest ? { checkpointRejection: checkpointRejectionRequest } : {}),
    };
}
