import logger from '../../utils/logger.js';

/**
 * Delivery bookkeeping for a prompt that carries operator input. Starting the
 * local `docker` client is not a handoff: the agent receives the prompt only
 * once its container runs.
 */
export interface PromptHandoff {
    /**
     * Awaited before the process is started with the prompt, so the handoff is
     * durable before any agent can see the input. A rejection starts nothing.
     */
    beforeStart(): Promise<void>;
    /** The agent produced output, so it received the prompt. */
    received(): void;
    /** Startup conclusively failed before any agent received the prompt. */
    notReceived(): void;
}

/** `docker run` exits with 125 when the daemon failed and no container ran its command. */
const DOCKER_RUN_DAEMON_FAILURE = 125;

export interface PromptHandoffTracker {
    /** The process wrote to stdout: for `docker run`, that is the container's output. */
    output(): void;
    /** The process was never started (spawn failure, refused before spawn). */
    notStarted(): void;
    /** The process exited; only a daemon failure without any output proves nothing was received. */
    exited(exitCode: number | null): void;
}

const INACTIVE_TRACKER: PromptHandoffTracker = Object.freeze({
    output: () => undefined,
    notStarted: () => undefined,
    exited: () => undefined,
});

/**
 * Settles one execution's handoff once: received on the first output, not
 * received only on conclusive startup failure, otherwise left uncertain.
 */
export function trackPromptHandoff(
    handoff: PromptHandoff | undefined,
    context: { dockerRun: boolean; taskId?: string },
): PromptHandoffTracker {
    if (!handoff) return INACTIVE_TRACKER;
    let settled = false;
    const settle = (notify: () => void): void => {
        if (settled) return;
        settled = true;
        try { notify(); } catch (error) {
            logger.warn({ taskId: context.taskId, error: (error as Error).message }, 'Prompt handoff callback failed');
        }
    };
    return {
        output: () => settle(() => handoff.received()),
        notStarted: () => settle(() => handoff.notReceived()),
        exited: exitCode => {
            if (context.dockerRun && exitCode === DOCKER_RUN_DAEMON_FAILURE) settle(() => handoff.notReceived());
        },
    };
}
