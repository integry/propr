import type { Writable } from 'node:stream';
import logger from '../../utils/logger.js';

export interface LiveInputMessage {
    id: string;
    text: string;
}

/**
 * Durable source of operator input for a running agent. `claim` marks the
 * returned messages delivered before they are written, so a message is never
 * handed to an agent twice, even across a worker restart.
 */
export interface LiveInputSource {
    claim(): Promise<LiveInputMessage[]>;
    /** Records that a claimed message was fully written to the agent's input. */
    acknowledge(id: string): Promise<void>;
    /** Returns claimed messages that were never written, so a later run can receive them. */
    release(ids: string[]): Promise<void>;
}

/**
 * Keeps an agent's stdin open as a control channel: the initial input is
 * written at start, claimed operator messages are written as they arrive once
 * the agent itself produced output, and stdin is closed once the agent reports
 * the end of its run.
 */
export interface LiveInputOptions {
    /** Already encoded initial input (the task prompt). */
    initialInput: string;
    source: LiveInputSource;
    /** Encodes one operator message as a provider input record. */
    encode(text: string): string;
    /** Whether a complete stdout record ends the run, after which no input is accepted. */
    endsInput(line: string): boolean;
    pollIntervalMs?: number;
}

export interface LiveInputChannel {
    /** Inspect one complete stdout record: the agent's own output, which proves it is running. */
    observeLine(line: string): void;
    /**
     * The run's output records for a raw stdout chunk: provider protocols
     * whose stdout is not that record stream translate it here; others
     * return it unchanged. `flush` passes the final chunk.
     */
    translateOutput(chunk: string, flush: boolean): string;
    /**
     * Whether the agent's own output showed it received its prompt, for
     * protocols whose output starts before the prompt is handed over;
     * without it, any output record is that evidence.
     */
    promptReceived?(): boolean;
    /** Stop polling and close stdin; safe to call repeatedly. */
    close(): void;
    /** Resolves once in-flight claims and acknowledgements have settled. */
    settled(): Promise<void>;
}

export interface LiveInputContext {
    taskId?: string;
    /** Called for every message written, so the caller can treat operator input as run activity. */
    onDelivered?: (message: LiveInputMessage) => void;
}

/**
 * A provider's own live input protocol on a spawned process' stdio, for
 * agents that do not read input as appended stdin records.
 */
export interface LiveInputSession {
    start(stdin: Writable | null | undefined, context: LiveInputContext): LiveInputChannel;
}

export function isLiveInputSession(input: LiveInputOptions | LiveInputSession): input is LiveInputSession {
    return typeof (input as LiveInputSession).start === 'function';
}

export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** The channel of an execution without live input: every call is a no-op. */
export const INACTIVE_LIVE_INPUT: LiveInputChannel = Object.freeze({
    observeLine: () => undefined,
    translateOutput: (chunk: string) => chunk,
    close: () => undefined,
    settled: async () => undefined,
});

/**
 * Start a live input channel on an already spawned process' stdin.
 * `onDelivered` is called for every message written, so the caller can treat
 * operator input as run activity.
 */
export function startLiveInput(
    stdin: Writable | null | undefined,
    options: LiveInputOptions,
    context: LiveInputContext,
): LiveInputChannel {
    let closed = false;
    // A started `docker` client buffers input before any container runs: a
    // write it accepts reaches no agent if startup then fails. Operator input
    // is claimed only once the agent's own output shows it is reading.
    let agentRunning = false;
    let polling: Promise<void> = Promise.resolve();
    const acknowledgements = new Set<Promise<void>>();
    const writable = (): boolean => !closed && !!stdin?.writable && !stdin.writableEnded;

    let timer: ReturnType<typeof setInterval> | undefined;
    // Idempotent and unconditional: an input that already failed or ended
    // still stops polling, so no timer outlives the execution.
    const close = (): void => {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
        if (closed) return;
        closed = true;
        try { stdin?.end(); } catch { /* the process already closed its input */ }
    };

    stdin?.on('error', error => {
        logger.warn({ taskId: context.taskId, error: error.message }, 'Agent live input channel closed with an error');
        close();
    });
    stdin?.write(options.initialInput);

    const acknowledge = (message: LiveInputMessage): void => {
        const pending = options.source.acknowledge(message.id).catch(error => {
            logger.warn({ taskId: context.taskId, steerId: message.id, error: (error as Error).message }, 'Failed to acknowledge operator input');
        });
        acknowledgements.add(pending);
        void pending.finally(() => acknowledgements.delete(pending));
    };

    const deliver = async (): Promise<void> => {
        // Claim only while the input can still be written and an agent reads
        // it: a claimed message is settled, so claiming after the run ended,
        // or before any agent ran, would lose it.
        if (!writable() || !agentRunning) return;
        let messages: LiveInputMessage[];
        try {
            messages = await options.source.claim();
        } catch (error) {
            logger.warn({ taskId: context.taskId, error: (error as Error).message }, 'Failed to load operator input for running agent');
            return;
        }
        const unwritten: string[] = [];
        for (const message of messages) {
            if (!writable()) {
                unwritten.push(message.id);
                continue;
            }
            stdin!.write(options.encode(message.text), error => {
                if (error) {
                    logger.warn({ taskId: context.taskId, steerId: message.id, error: error.message }, 'Failed to write operator input to agent');
                    return;
                }
                acknowledge(message);
            });
            context.onDelivered?.(message);
        }
        // Nothing of these reached the agent, so releasing them cannot duplicate input.
        if (unwritten.length) {
            await options.source.release(unwritten).catch(error => {
                logger.warn({ taskId: context.taskId, error: (error as Error).message }, 'Failed to release unwritten operator input');
            });
        }
    };

    // The initial write can fail synchronously into the error handler; never
    // start polling an input that is already closed.
    if (!closed) {
        timer = setInterval(() => {
            // Never overlap claims: each poll waits for the previous one.
            polling = polling.then(deliver);
        }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        timer.unref?.();
    }

    return {
        translateOutput: chunk => chunk,
        observeLine: line => {
            agentRunning = true;
            if (!closed && options.endsInput(line)) close();
        },
        close,
        settled: async () => {
            await polling;
            await Promise.allSettled([...acknowledgements]);
        },
    };
}

/** Open an execution's live input channel on its spawned process' stdin. */
export function openLiveInput(
    stdin: Writable | null | undefined,
    input: LiveInputOptions | LiveInputSession | undefined,
    context: LiveInputContext,
): LiveInputChannel {
    if (!input) return INACTIVE_LIVE_INPUT;
    return isLiveInputSession(input) ? input.start(stdin, context) : startLiveInput(stdin, input, context);
}
