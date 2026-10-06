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
 * written at start, claimed operator messages are written as they arrive, and
 * stdin is closed once the agent reports the end of its run.
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
    /** Inspect one complete stdout record. */
    observeLine(line: string): void;
    /** Stop polling and close stdin; safe to call repeatedly. */
    close(): void;
    /** Resolves once in-flight claims and acknowledgements have settled. */
    settled(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** The channel of an execution without live input: every call is a no-op. */
export const INACTIVE_LIVE_INPUT: LiveInputChannel = Object.freeze({
    observeLine: () => undefined,
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
    context: { taskId?: string; onDelivered?: (message: LiveInputMessage) => void },
): LiveInputChannel {
    let closed = false;
    let polling: Promise<void> = Promise.resolve();
    const acknowledgements = new Set<Promise<void>>();
    const writable = (): boolean => !closed && !!stdin?.writable && !stdin.writableEnded;

    stdin?.on('error', error => {
        logger.warn({ taskId: context.taskId, error: error.message }, 'Agent live input channel closed with an error');
        closed = true;
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
        // Claim only while the input can still be written: a claimed message
        // is settled, so claiming after the run ended would lose it.
        if (!writable()) return;
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

    const timer = setInterval(() => {
        // Never overlap claims: each poll waits for the previous one.
        polling = polling.then(deliver);
    }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    timer.unref?.();

    const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try { stdin?.end(); } catch { /* the process already closed its input */ }
    };

    return {
        observeLine: line => { if (!closed && options.endsInput(line)) close(); },
        close,
        settled: async () => {
            await polling;
            await Promise.allSettled([...acknowledgements]);
        },
    };
}
