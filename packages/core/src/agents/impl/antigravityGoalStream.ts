import { antigravityModelIdsMatch, antigravityReportedIdentity } from './antigravityModelIds.js';
import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { TokenUsage } from '../types.js';
import { boundedProviderDiagnostic } from './utils/boundedProviderOutput.js';
import { stripWorkflowAgentStderrPrefix } from '../../workflow/workflowExecution.js';
import type { LiveAgentOutput } from './utils/liveAgentOutput.js';

/** Antigravity's `/goal` hook marks a goal it judged finished with this line. */
export const ANTIGRAVITY_GOAL_COMPLETE_MARKER = '<!-- GOAL_COMPLETE -->';

export interface AntigravitySegmentResult {
    status: 'success' | 'error';
    response: string;
}

interface StreamUsage {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
}

interface StreamEnvelope {
    event?: string;
    conversation_id?: string;
    init?: { model?: string };
    step_update?: {
        step_index?: number;
        state?: string;
        step_type?: string;
        text_delta?: string;
        usage?: StreamUsage;
    };
    result?: { status?: string; response?: string };
}

/**
 * Sum the last usage snapshot of every step. `result.usage` is cumulative over
 * the whole conversation, including earlier invocations, while step usage is
 * the cost of that step's model call, so the step sum is this invocation's cost.
 */
export function sumAntigravityStepUsage(stepUsage: Iterable<StreamUsage>): TokenUsage {
    const total: TokenUsage = { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    let cacheIncomplete = false;
    for (const usage of stepUsage) {
        total.input_tokens! += usage.input_tokens ?? 0;
        total.output_tokens! += usage.output_tokens ?? 0;
        // A step that reports no cache count leaves the breakdown unknown rather than adding a zero,
        // and if that step carried a prompt the whole invocation's breakdown is incomplete.
        if (usage.cache_read_tokens !== undefined) total.cache_read_input_tokens = (total.cache_read_input_tokens ?? 0) + usage.cache_read_tokens;
        else if ((usage.input_tokens ?? 0) > 0) cacheIncomplete = true;
        total.reasoning_output_tokens! += usage.thinking_tokens ?? 0;
    }
    if (cacheIncomplete) {
        // The cached tokens the other steps counted are still prompt tokens: they return to
        // input_tokens so the invocation's total survives, and only the breakdown is withheld.
        total.input_tokens! += total.cache_read_input_tokens ?? 0;
        delete total.cache_read_input_tokens;
    }
    return total;
}

/** The provider surface one goal invocation exposes; tests substitute a scripted segment. */
export interface AntigravityGoalSegment {
    readonly conversationId?: string;
    readonly model?: string;
    /** Whether the latest step is still running (not a safe interrupt boundary). */
    readonly stepActive: boolean;
    /** Whether any step of this invocation has finished. */
    readonly stepCompleted: boolean;
    readonly result?: AntigravitySegmentResult;
    readonly exited: boolean;
    readonly errorText?: string;
    readonly protocolError?: string;
    readonly tokenUsage: TokenUsage;
    readonly textCursor: number;
    textsAfter(cursor: number): string[];
    interrupt(): void;
    waitForActivity(timeoutMs: number): Promise<void>;
    waitForExit(): Promise<void>;
}

/** One `agy --print` invocation of a goal conversation, observed line by line. */
export class AntigravityGoalStream implements AntigravityGoalSegment {
    private stderr = '';
    private identityError?: string;
    private texts: string[] = [];
    private pendingText = new Map<number, string>();
    private stepUsage = new Map<number, StreamUsage>();
    private wake: (() => void) | null = null;
    private readonly exit: Promise<void>;
    conversationId?: string;
    model?: string;
    stepActive = false;
    stepCompleted = false;
    result?: AntigravitySegmentResult;
    exited = false;

    constructor(private readonly child: ChildProcess, private readonly output: LiveAgentOutput, private readonly requestedCliModel?: string) {
        child.stderr?.on('data', chunk => {
            this.stderr = boundedProviderDiagnostic(this.stderr + chunk.toString());
        });
        readline.createInterface({ input: child.stdout! }).on('line', line => this.onLine(line));
        this.exit = new Promise(resolve => {
            const done = (): void => {
                this.exited = true;
                this.notify();
                resolve();
            };
            child.once('close', done);
            child.once('error', error => {
                this.stderr = boundedProviderDiagnostic(`${this.stderr}\n${error.message}`);
                done();
            });
        });
        child.stdin?.on('error', () => undefined);
    }

    get protocolError(): string | undefined { return this.identityError; }

    get textCursor(): number { return this.texts.length; }
    get tokenUsage(): TokenUsage { return sumAntigravityStepUsage(this.stepUsage.values()); }

    /** The CLI's own failure line (`error: …` / `AGY_ERROR`), else its last diagnostic. */
    get errorText(): string | undefined {
        if (this.identityError) return this.identityError;
        // A repository workflow wrapper labels agent stderr lines; match the CLI's own text.
        const lines = this.stderr.split('\n').map(line => stripWorkflowAgentStderrPrefix(line.trim()).trim()).filter(Boolean);
        return lines.filter(line => /^(?:error:|AGY_ERROR)/.test(line)).pop() ?? lines.pop();
    }

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
        if (this.identityError) return;
        if (envelope.event === 'init' && typeof envelope.conversation_id === 'string') {
            const reported = envelope.init?.model;
            if (this.hasModelIdentityConflict(reported)) {
                this.identityError = `Antigravity reported model "${reported}" but "${this.requestedCliModel ?? this.model}" was requested`;
                this.result = { status: 'error', response: '' };
                this.interrupt();
                this.notify();
                return;
            }
            this.conversationId = envelope.conversation_id;
            if (reported) this.model = reported;
        } else if (envelope.event === 'step_update' && envelope.step_update) {
            this.onStep(envelope.step_update);
        } else if (envelope.event === 'result' && envelope.result) {
            this.result = {
                status: envelope.result.status?.toUpperCase() === 'SUCCESS' ? 'success' : 'error',
                response: envelope.result.response ?? '',
            };
        }
        this.notify();
    }

    private hasModelIdentityConflict(reported: string | undefined): boolean {
        const conflict = this.model && reported && JSON.stringify(antigravityReportedIdentity(this.model)) !== JSON.stringify(antigravityReportedIdentity(reported));
        return Boolean(conflict || (this.requestedCliModel && (!reported || !antigravityModelIdsMatch(this.requestedCliModel, reported))));
    }

    private onStep(step: NonNullable<StreamEnvelope['step_update']>): void {
        const index = step.step_index;
        if (typeof index !== 'number') return;
        if (step.usage) this.stepUsage.set(index, step.usage);
        const done = step.state === 'DONE';
        this.stepActive = !done;
        this.stepCompleted ||= done;
        if (step.step_type !== 'agent_response') return;
        const text = (this.pendingText.get(index) ?? '') + (step.text_delta ?? '');
        if (!done) {
            this.pendingText.set(index, text);
            return;
        }
        this.pendingText.delete(index);
        if (text.trim()) this.texts.push(text);
    }

    /** Ctrl+C: the CLI ends the turn, persists the conversation, and exits. */
    interrupt(): void {
        this.child.kill('SIGINT');
    }

    waitForActivity(timeoutMs: number): Promise<void> {
        if (this.exited) return Promise.resolve();
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

    waitForExit(): Promise<void> {
        return this.exit;
    }
}
