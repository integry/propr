import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { TokenUsage } from '../types.js';
import { boundedProviderDiagnostic } from './utils/boundedProviderOutput.js';
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
    const total = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, reasoning_output_tokens: 0 };
    for (const usage of stepUsage) {
        total.input_tokens += usage.input_tokens ?? 0;
        total.output_tokens += usage.output_tokens ?? 0;
        total.cache_read_input_tokens += usage.cache_read_tokens ?? 0;
        total.reasoning_output_tokens += usage.thinking_tokens ?? 0;
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

    constructor(private readonly child: ChildProcess, private readonly output: LiveAgentOutput) {
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

    get textCursor(): number { return this.texts.length; }
    get tokenUsage(): TokenUsage { return sumAntigravityStepUsage(this.stepUsage.values()); }

    /** The CLI's own failure line (`error: …` / `AGY_ERROR`), else its last diagnostic. */
    get errorText(): string | undefined {
        const lines = this.stderr.split('\n').map(line => line.trim()).filter(Boolean);
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
        if (envelope.event === 'init' && typeof envelope.conversation_id === 'string') {
            this.conversationId = envelope.conversation_id;
            if (typeof envelope.init?.model === 'string') this.model = envelope.init.model;
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
