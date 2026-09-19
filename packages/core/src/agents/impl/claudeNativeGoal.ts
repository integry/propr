/* eslint-disable max-lines -- the live Claude goal session, its transcript goal state, and the protocol loop share one boundary */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
    GOAL_CONTINUE_INPUT,
    NATIVE_GOAL_COMMAND_PREFIX,
    parseGoalCheckpointDeclaration,
} from '../../goals.js';
import logger from '../../utils/logger.js';
import {
    getDockerRunContainerName,
    getExecutionAbortError,
    getExecutionOwnershipContext,
    resolveExecutionArgs,
} from '../../claude/docker/dockerExecutionOwnership.js';
import type {
    AgentExecutionResult,
    AgentTaskOptions,
    GoalCheckpointOutcome,
    GoalExecutionControl,
    TokenUsage,
} from '../types.js';
import { boundedProviderDiagnostic } from './utils/boundedProviderOutput.js';
import { LiveAgentOutput } from './utils/liveAgentOutput.js';
import { processDockerResult } from './utils/dockerResultProcessor.js';

const execFileAsync = promisify(execFile);
const CONTROL_POLL_MS = 400;
const MAX_UNEXPLAINED_TURN_ENDS = 3;
const LOCAL_COMMAND_TIMEOUT_MS = 30_000;
const CONTEXT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** Claude stores transcripts under a slug of the container workspace path. */
const CLAUDE_WORKSPACE_PROJECT_SLUG = '-home-node-workspace';

export const CLAUDE_GOAL_CONTEXT_PREAMBLE = [
    'ProPR delivery context for the goal that follows in the next message.',
    'Read and retain it, but do not start working yet: reply with a one-line acknowledgement only.',
].join(' ');

export type ClaudeGoalStatus = 'none' | 'active' | 'complete' | 'failed' | 'cleared' | 'unknown';

export interface ClaudeGoalState {
    status: ClaudeGoalStatus;
    reason?: string;
    iterations: number;
    setAt?: number;
}

interface GoalStatusAttachment {
    type?: string;
    met?: boolean;
    failed?: boolean;
    sentinel?: boolean;
    condition?: string;
    reason?: string;
}

export function claudeGoalCondition(command: string): string {
    return (command.startsWith(NATIVE_GOAL_COMMAND_PREFIX)
        ? command.slice(NATIVE_GOAL_COMMAND_PREFIX.length)
        : command).trim();
}

export function claudeSessionTranscriptPath(configPath: string, sessionId: string): string {
    return path.join(configPath, 'projects', CLAUDE_WORKSPACE_PROJECT_SLUG, `${sessionId}.jsonl`);
}

/**
 * Reduce the session transcript's `goal_status` records for one condition.
 * Sentinels mark set (met=false) and clear (met=true); evaluations carry the
 * Stop-hook verdict: met, failed (impossible), or not yet met.
 */
export function readClaudeGoalState(transcript: string, condition: string): ClaudeGoalState {
    const wanted = condition.trim();
    const state: ClaudeGoalState = { status: 'none', iterations: 0 };
    for (const line of transcript.split('\n')) {
        if (!line.includes('"goal_status"')) continue;
        let record: { type?: string; timestamp?: string; attachment?: GoalStatusAttachment };
        try { record = JSON.parse(line) as typeof record; } catch { continue; }
        const attachment = record.attachment;
        if (record.type !== 'attachment' || attachment?.type !== 'goal_status') continue;
        if ((attachment.condition ?? '').trim() !== wanted) continue;
        if (attachment.sentinel) {
            if (attachment.met) {
                state.status = 'cleared';
            } else {
                state.status = 'active';
                state.iterations = 0;
                const setAt = record.timestamp ? Date.parse(record.timestamp) : NaN;
                if (!Number.isNaN(setAt)) state.setAt = setAt;
            }
            delete state.reason;
            continue;
        }
        state.iterations += 1;
        state.reason = attachment.reason;
        state.status = attachment.failed ? 'failed' : attachment.met ? 'complete' : 'active';
    }
    return state;
}

async function loadClaudeGoalState(transcriptPath: string, condition: string): Promise<ClaudeGoalState> {
    try {
        return readClaudeGoalState(await fs.readFile(transcriptPath, 'utf8'), condition);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none', iterations: 0 };
        logger.warn({ transcriptPath, error: (error as Error).message }, 'Could not read Claude goal transcript');
        return { status: 'unknown', iterations: 0 };
    }
}

export async function claudeSessionTranscriptExists(transcriptPath: string): Promise<boolean> {
    return fs.access(transcriptPath).then(() => true, () => false);
}

export interface ClaudeTurnResult {
    isError: boolean;
    subtype?: string;
    text?: string;
}

interface StreamEnvelope {
    type?: string;
    subtype?: string;
    session_id?: string;
    model?: string;
    is_error?: boolean;
    result?: unknown;
    errors?: unknown;
    usage?: Record<string, unknown>;
    message?: { model?: string; content?: unknown };
}

function assistantText(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content
        .filter((block): block is { type: string; text: string } =>
            Boolean(block) && (block as { type?: unknown }).type === 'text'
            && typeof (block as { text?: unknown }).text === 'string')
        .map(block => block.text)
        .join('\n');
}

function resultText(envelope: StreamEnvelope): string | undefined {
    if (typeof envelope.result === 'string' && envelope.result) return envelope.result;
    if (Array.isArray(envelope.errors)) {
        const errors = envelope.errors.filter((value): value is string => typeof value === 'string');
        if (errors.length) return errors.join('\n');
    }
    return undefined;
}

/** Line-oriented stream-json session with stdin kept open as the control channel. */
export class ClaudeGoalStream {
    private readonly output: LiveAgentOutput;
    private stderr = '';
    private closedError: Error | null = null;
    private results: ClaudeTurnResult[] = [];
    private texts: string[] = [];
    private wake: (() => void) | null = null;
    private requestSequence = 0;
    private usage: Required<Omit<TokenUsage, 'reasoning_output_tokens'>> = {
        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    };
    sessionId?: string;
    model?: string;

    constructor(
        private readonly child: ChildProcess,
        taskId: string | undefined,
        persistOutput?: (records: string[]) => Promise<void>,
    ) {
        this.output = new LiveAgentOutput(taskId, persistOutput, 'claude-goal');
        child.stderr?.on('data', chunk => {
            this.stderr = boundedProviderDiagnostic(this.stderr + chunk.toString());
        });
        readline.createInterface({ input: child.stdout! }).on('line', line => this.onLine(line));
        child.once('close', code => this.close(new Error(`Claude goal session container exited before its turn completed (exit ${code ?? 'unknown'})`)));
        child.once('error', error => this.close(error));
    }

    get rawOutput(): string { return this.output.raw; }
    get stderrOutput(): string { return this.stderr; }
    get closeError(): Error | null { return this.closedError; }
    get exitCode(): number | null { return this.child.exitCode; }
    get tokenUsage(): TokenUsage { return { ...this.usage }; }
    get textCursor(): number { return this.texts.length; }

    textsAfter(cursor: number): string[] {
        return this.texts.slice(cursor);
    }

    private notify(): void {
        const wake = this.wake;
        this.wake = null;
        wake?.();
    }

    private onLine(line: string): void {
        this.output.append(`${line}\n`);
        let envelope: StreamEnvelope;
        try { envelope = JSON.parse(line) as StreamEnvelope; } catch { return; }
        if (envelope.type === 'system' && envelope.subtype === 'init') {
            if (typeof envelope.session_id === 'string') this.sessionId = envelope.session_id;
            if (typeof envelope.model === 'string') this.model = envelope.model;
        }
        if (envelope.type === 'assistant') {
            if (typeof envelope.message?.model === 'string' && !envelope.message.model.startsWith('<')) {
                this.model = envelope.message.model;
            }
            const text = assistantText(envelope.message?.content);
            if (text) {
                this.texts.push(text);
                this.notify();
            }
        }
        if (envelope.type === 'result') {
            for (const key of Object.keys(this.usage) as Array<keyof typeof this.usage>) {
                this.usage[key] += Number(envelope.usage?.[key] ?? 0) || 0;
            }
            this.results.push({ isError: envelope.is_error === true, subtype: envelope.subtype, text: resultText(envelope) });
            this.notify();
        }
    }

    private close(error: Error): void {
        this.closedError ??= error;
        this.notify();
    }

    private write(message: Record<string, unknown>): void {
        if (!this.child.stdin?.writable) throw this.closedError ?? new Error('Claude goal session stdin is closed');
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    send(text: string): void {
        this.write({
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            session_id: this.sessionId ?? '',
        });
    }

    interrupt(): void {
        this.requestSequence += 1;
        this.write({
            type: 'control_request',
            request_id: `propr-interrupt-${this.requestSequence}`,
            request: { subtype: 'interrupt' },
        });
    }

    /** Record a ProPR-side native goal snapshot in the live stream for projections. */
    appendGoalRecord(goal: Record<string, unknown>): void {
        this.output.append(`${JSON.stringify({ type: 'system', subtype: 'propr_native_goal', goal })}\n`);
    }

    takeResult(): ClaudeTurnResult | undefined {
        return this.results.shift();
    }

    /** Resolve on the next stream activity, or after `timeoutMs`. */
    waitForActivity(timeoutMs: number): Promise<void> {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                if (this.wake === done) this.wake = null;
                resolve();
            }, timeoutMs);
            const done = (): void => {
                clearTimeout(timer);
                resolve();
            };
            this.wake = done;
        });
    }

    async waitForResult(timeoutMs: number): Promise<ClaudeTurnResult> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const result = this.takeResult();
            if (result) return result;
            if (this.closedError) throw this.closedError;
            await this.waitForActivity(Math.min(CONTROL_POLL_MS, deadline - Date.now()));
        }
        throw new Error('Claude goal session did not finish its turn in time');
    }

    async shutdown(): Promise<void> {
        this.child.stdin?.end();
        const force = setTimeout(() => this.child.kill('SIGTERM'), 5_000);
        await new Promise<void>(resolve => {
            if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
            else this.child.once('close', () => resolve());
        });
        clearTimeout(force);
        await this.output.close();
    }
}

/** The live-session surface the protocol drives; tests substitute a scripted session. */
export type ClaudeGoalSession = Pick<ClaudeGoalStream,
    'closeError' | 'textCursor' | 'textsAfter' | 'send' | 'interrupt' | 'appendGoalRecord'
    | 'takeResult' | 'waitForActivity' | 'waitForResult'>;

export interface ClaudeGoalCompletion {
    status: 'completed' | 'failed' | 'interrupted';
    error?: string;
}

export interface ClaudeGoalContext {
    command: string;
    condition: string;
    sessionId: string;
    transcriptPath: string;
    startedAt: number;
}

interface TurnObservation {
    result: ClaudeTurnResult;
    stopRequested: GoalControlSnapshotState | null;
    declaration: ReturnType<typeof parseGoalCheckpointDeclaration>;
}

type GoalControlSnapshotState = 'paused' | 'cancelled';

interface InitialMessage {
    text: string | null;
    inputId?: string;
}

function impossibleGoalError(state: ClaudeGoalState): string {
    return `Claude native goal was judged impossible: ${state.reason || 'no reason given'}`;
}

function checkpointFeedback(outcome: GoalCheckpointOutcome): string {
    if (!outcome.accepted) {
        return `ProPR rejected your checkpoint declaration: ${outcome.error || 'The declaration could not be published'}. No checkpoint was committed. Correct the declaration and continue working toward the goal.`;
    }
    return outcome.commitSha
        ? `ProPR accepted and published your checkpoint as commit ${outcome.commitSha}. Continue working toward the goal.`
        : 'ProPR accepted your checkpoint, but there were no matching changes to commit. Continue working toward the goal.';
}

class ClaudeGoalProtocol {
    private turn = 0;
    private readonly control: GoalExecutionControl;

    constructor(
        private readonly stream: ClaudeGoalSession,
        private readonly options: AgentTaskOptions,
        private readonly context: ClaudeGoalContext,
    ) {
        this.control = options.goalControl!;
    }

    private nextTurnId(): string {
        this.turn += 1;
        return `${this.context.sessionId}:${this.turn}`;
    }

    private async goalState(): Promise<ClaudeGoalState> {
        return loadClaudeGoalState(this.context.transcriptPath, this.context.condition);
    }

    private recordGoal(status: string, state?: ClaudeGoalState): void {
        this.stream.appendGoalRecord({
            objective: this.context.condition,
            status,
            iterations: state?.iterations ?? 0,
            setAt: state?.setAt ?? this.context.startedAt,
            updatedAt: Date.now(),
            ...(state?.reason ? { lastReason: state.reason } : {}),
        });
    }

    /** Run one local slash command or acknowledgement-only turn to its result. */
    private async runBoundedTurn(text: string, timeoutMs: number): Promise<ClaudeTurnResult> {
        this.stream.send(text);
        return this.stream.waitForResult(timeoutMs);
    }

    private async deliverInputs(turnId: string): Promise<GoalControlSnapshotState | null> {
        const snapshot = await this.control.load();
        if (snapshot.desiredState !== 'running') return snapshot.desiredState;
        for (const input of snapshot.pendingInputs) {
            this.stream.send(input.message);
            await this.control.markInputDelivered(input.id, turnId);
        }
        return null;
    }

    private async observeTurn(turnId: string): Promise<TurnObservation> {
        await this.control.setActiveTurn(turnId);
        const cursor = this.stream.textCursor;
        let stopRequested: GoalControlSnapshotState | null = null;
        let interrupted = false;
        let declaration: TurnObservation['declaration'] = null;
        while (true) {
            const result = this.stream.takeResult();
            if (result) {
                await this.control.setActiveTurn(null);
                return { result, stopRequested, declaration };
            }
            if (this.stream.closeError) throw this.stream.closeError;
            await this.stream.waitForActivity(CONTROL_POLL_MS);
            await this.control.heartbeat();
            if (!declaration) {
                declaration = parseGoalCheckpointDeclaration(this.stream.textsAfter(cursor).join('\n'));
            }
            if (!stopRequested) stopRequested = await this.deliverInputs(turnId);
            // A checkpoint declaration ends the agent's turn; interrupting the
            // pending Stop-hook evaluation gives ProPR the same boundary Codex
            // gets from a completed native turn. The goal itself stays set.
            if ((declaration || stopRequested) && !interrupted) {
                interrupted = true;
                this.stream.interrupt();
            }
        }
    }

    private async publishDeclaration(
        declaration: NonNullable<TurnObservation['declaration']>,
        turnId: string,
    ): Promise<string> {
        if ('rejected' in declaration) {
            await this.control.rejectCheckpoint({
                kind: 'agent', error: declaration.error, commitMessage: declaration.message,
                include: declaration.include, exclude: declaration.exclude, summary: declaration.summary,
            }, turnId);
            return checkpointFeedback({ accepted: false, error: declaration.error });
        }
        const outcome = await this.control.publishCheckpoint({
            kind: 'agent', commitMessage: declaration.message,
            include: declaration.include, exclude: declaration.exclude, summary: declaration.summary,
        }, turnId);
        return checkpointFeedback(outcome);
    }

    private async stop(desiredState: GoalControlSnapshotState, state: ClaudeGoalState): Promise<ClaudeGoalCompletion> {
        if (desiredState === 'cancelled' && state.status === 'active') {
            await this.runBoundedTurn('/goal clear', LOCAL_COMMAND_TIMEOUT_MS).catch(() => undefined);
            this.recordGoal('cleared', state);
        } else {
            this.recordGoal('paused', state);
        }
        return { status: 'interrupted', error: 'Goal stopped at a provider turn boundary' };
    }

    /** Establish the goal in this session and return the first steering message, if any. */
    private async start(state: ClaudeGoalState): Promise<ClaudeGoalCompletion | InitialMessage> {
        const { options } = this;
        const inputId = options.initialControlInputId;
        const text = options.initialGoalFeedback ?? options.initialControlInputMessage;
        if (state.status === 'complete') {
            if (inputId) {
                await this.control.markInputUndeliverable(
                    inputId,
                    'Claude native goal completed before this FIFO input could be delivered',
                );
            }
            this.recordGoal('complete', state);
            return { status: 'completed' };
        }
        if (state.status === 'failed') {
            this.recordGoal('failed', state);
            return { status: 'failed', error: impossibleGoalError(state) };
        }
        if (state.status === 'active') return { text: text ?? GOAL_CONTINUE_INPUT, inputId };
        // A fresh session receives its launch context before the goal exists,
        // so the goal's first turn already works under ProPR's delivery policy.
        if (text && !options.resumeSessionId) {
            const acknowledged = await this.runBoundedTurn(`${CLAUDE_GOAL_CONTEXT_PREAMBLE}\n\n${text}`, CONTEXT_TURN_TIMEOUT_MS);
            if (acknowledged.isError) {
                return { status: 'failed', error: acknowledged.text || 'Claude could not accept the goal delivery context' };
            }
            if (inputId) await this.control.markInputDelivered(inputId, `${this.context.sessionId}:context`);
            this.stream.send(this.context.command);
            return { text: null };
        }
        // A resumed session without a live goal (cleared, or created before
        // native goals) sets it again and then receives its pending message.
        this.stream.send(this.context.command);
        return { text: text ?? null, inputId };
    }

    /**
     * Decide what a turn boundary means: the goal finished, stopped, failed,
     * or continues with checkpoint feedback or a nudge.
     */
    private async settleTurn(
        { result, stopRequested, declaration }: TurnObservation,
        feedback: string | undefined,
    ): Promise<ClaudeGoalCompletion | { next: string; nudge: boolean }> {
        const state = await this.goalState();
        // Without a readable transcript, an uninterrupted successful turn
        // end can only mean the Stop hook released the goal.
        if (state.status === 'complete'
            || (state.status === 'unknown' && !result.isError && !declaration && !stopRequested)) {
            this.recordGoal('complete', state);
            return { status: 'completed' };
        }
        if (state.status === 'failed') {
            this.recordGoal('failed', state);
            return { status: 'failed', error: impossibleGoalError(state) };
        }
        const snapshot = await this.control.load();
        if (snapshot.desiredState !== 'running') return this.stop(snapshot.desiredState, state);
        if (state.status !== 'active' && state.status !== 'unknown') {
            this.recordGoal('cleared', state);
            return {
                status: 'failed',
                error: `Claude cleared the native goal before it was met${result.text ? `: ${result.text}` : ''}`,
            };
        }
        this.recordGoal('active', state);
        if (feedback) return { next: feedback, nudge: false };
        if (result.isError && !stopRequested) {
            return { status: 'failed', error: result.text || `Claude goal turn ended with ${result.subtype || 'an error'}` };
        }
        return { next: GOAL_CONTINUE_INPUT, nudge: true };
    }

    async run(): Promise<ClaudeGoalCompletion> {
        const initialState = await this.goalState();
        if ((await this.control.load()).desiredState !== 'running') {
            return { status: 'interrupted', error: 'Goal stopped before provider turn observation' };
        }
        const started = await this.start(initialState);
        if ('status' in started) return started;
        this.recordGoal('active', { ...initialState, status: 'active' });
        let next: InitialMessage | null = started;
        let nudges = 0;
        while (true) {
            const turnId = this.nextTurnId();
            if (next?.text) {
                this.stream.send(next.text);
                if (next.inputId) await this.control.markInputDelivered(next.inputId, turnId);
            }
            const turn = await this.observeTurn(turnId);
            const feedback = turn.declaration ? await this.publishDeclaration(turn.declaration, turnId) : undefined;
            const settled = await this.settleTurn(turn, feedback);
            if ('status' in settled) return settled;
            nudges = settled.nudge ? nudges + 1 : 0;
            if (nudges > MAX_UNEXPLAINED_TURN_ENDS) {
                return { status: 'failed', error: 'Claude repeatedly ended its turn while the native goal remained unmet' };
            }
            next = { text: settled.next };
        }
    }
}

export async function runClaudeGoalProtocol(
    stream: ClaudeGoalSession,
    options: AgentTaskOptions,
    context: ClaudeGoalContext,
): Promise<ClaudeGoalCompletion> {
    return new ClaudeGoalProtocol(stream, options, context).run();
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

export interface ClaudeNativeGoalLaunch {
    dockerArgs: string[];
    sessionId: string;
    transcriptPath: string;
    model: string;
    timeoutMs: number;
}

/** Run one attempt of a Claude native `/goal` session with live ProPR controls. */
export async function executeClaudeNativeGoal(
    options: AgentTaskOptions,
    launch: ClaudeNativeGoalLaunch,
): Promise<AgentExecutionResult> {
    const start = Date.now();
    const control = options.goalControl;
    if (!control || !options.nativeGoalObjective) {
        throw new Error('Claude native goal execution requires durable goal controls and an objective');
    }
    const command = options.nativeGoalObjective.startsWith(NATIVE_GOAL_COMMAND_PREFIX)
        ? options.nativeGoalObjective
        : `${NATIVE_GOAL_COMMAND_PREFIX}${options.nativeGoalObjective}`;
    const ownership = getExecutionOwnershipContext();
    const args = resolveExecutionArgs('docker', launch.dockerArgs, options.taskId, ownership?.attemptGeneration);
    // The identity is assigned up front, so persist it before any provider work.
    await options.onSessionId?.(launch.sessionId);
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: options.worktreePath });
    const abort = (): void => { child.kill('SIGTERM'); };
    ownership?.signal.addEventListener('abort', abort, { once: true });
    const stream = new ClaudeGoalStream(child, options.taskId, records => control.appendOutput(records));
    void detectContainer(getDockerRunContainerName(args), options.onContainerId);
    const deadline = setTimeout(() => child.kill('SIGTERM'), launch.timeoutMs);
    let completion: ClaudeGoalCompletion;
    try {
        completion = await runClaudeGoalProtocol(stream, options, {
            command,
            condition: claudeGoalCondition(command),
            sessionId: launch.sessionId,
            transcriptPath: launch.transcriptPath,
            startedAt: start,
        });
    } catch (error) {
        const abortError = getExecutionAbortError(ownership?.signal);
        completion = { status: 'failed', error: (abortError ?? error as Error).message };
    } finally {
        clearTimeout(deadline);
        ownership?.signal.removeEventListener('abort', abort);
        await control.setActiveTurn(null).catch(() => undefined);
        await stream.shutdown();
    }
    const { response } = processDockerResult(
        {
            stdout: stream.rawOutput, stderr: stream.stderrOutput, messageTimestamps: new Map(),
            exitCode: completion.status === 'completed' ? 0 : stream.exitCode ?? 1,
        },
        command,
        launch.model,
        Date.now() - start,
    );
    const success = completion.status === 'completed';
    return {
        ...response,
        success,
        logs: `${stream.rawOutput}${stream.stderrOutput ? `\n${stream.stderrOutput}` : ''}`,
        sessionId: launch.sessionId,
        conversationId: launch.sessionId,
        modelUsed: stream.model || response.modelUsed,
        providerModel: stream.model || response.providerModel,
        tokenUsage: stream.tokenUsage,
        exitCode: success ? 0 : stream.exitCode,
        terminationReason: undefined,
        error: success ? undefined : completion.error || response.error || 'Claude native goal did not complete',
    };
}
