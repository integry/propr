import logger from '../../utils/logger.js';
import { AgentActivityWatchdog, watchdogPollIntervalMs, type AgentWatchdogSettings, type AgentWatchdogTrip } from './agentActivityWatchdog.js';

export interface ExecutionWatchdogOptions {
    taskId?: string;
    streamToRedis?: boolean;
    preserveOutputOnTimeout?: boolean;
    /** `false` disables the watchdog; an object supplies thresholds instead of the instance settings. */
    watchdog?: false | AgentWatchdogSettings;
    onWatchdogTrip?: (taskId: string, trip: AgentWatchdogTrip) => void | Promise<void>;
}

/**
 * The watchdog runs for streamed agent runs that preserve partial output, the
 * shape every implementation agent (Claude, Codex, Antigravity, OpenCode,
 * Vibe) uses, unless the caller supplies or disables it explicitly.
 */
export function executionWatchdogApplies(options: ExecutionWatchdogOptions): boolean {
    if (options.watchdog === false) return false;
    if (options.watchdog) return true;
    return !!(options.streamToRedis && options.taskId && options.preserveOutputOnTimeout);
}

async function resolveSettings(options: ExecutionWatchdogOptions): Promise<AgentWatchdogSettings | null> {
    if (!executionWatchdogApplies(options)) return null;
    if (options.watchdog) return options.watchdog;
    try {
        // Loaded lazily so plain Docker commands never touch the settings store.
        const { loadAgentWatchdogSettings } = await import('../../config/configManagerAgentWatchdog.js');
        return await loadAgentWatchdogSettings();
    } catch (error) {
        logger.warn({ taskId: options.taskId, error: (error as Error).message }, 'Could not load agent watchdog settings; watchdog disabled for this run');
        return null;
    }
}

async function report(options: ExecutionWatchdogOptions, trip: AgentWatchdogTrip): Promise<void> {
    if (!options.taskId) return;
    try {
        if (options.onWatchdogTrip) { await options.onWatchdogTrip(options.taskId, trip); return; }
        const { reportAgentWatchdogTrip } = await import('./agentWatchdogReporting.js');
        await reportAgentWatchdogTrip(options.taskId, trip);
    } catch (error) {
        logger.warn({ taskId: options.taskId, error: (error as Error).message }, 'Failed to report agent watchdog trip');
    }
}

export interface ExecutionWatchdog {
    /** Any output from the process: a chunk on stdout or stderr, a changed transcript snapshot. */
    recordActivity(): void;
    /** One complete stdout record, classified for text deltas and tool calls. */
    observeLine(line: string): void;
    /** The trip that stopped this execution, once {@link ExecutionWatchdog.stop} accepted it. */
    readonly trip: AgentWatchdogTrip | null;
    stop(): void;
    /** Resolves once the trip's observability writes have settled. */
    settled(): Promise<void>;
}

/**
 * Starts the watchdog for one execution. `stopExecution` is called at most
 * once, when a trip is accepted; it returns false when the execution is
 * already being stopped for another reason, which then keeps its outcome.
 */
export function startExecutionWatchdog(options: ExecutionWatchdogOptions, stopExecution: () => boolean): ExecutionWatchdog {
    let watchdog: AgentActivityWatchdog | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let accepted: AgentWatchdogTrip | null = null;
    let reporting: Promise<void> = Promise.resolve();
    const stop = (): void => {
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
    };
    const onTrip = (trip: AgentWatchdogTrip): void => {
        if (closed) return;
        stop();
        if (!stopExecution()) return;
        accepted = trip;
        reporting = report(options, trip);
    };
    void resolveSettings(options).then(settings => {
        if (!settings || closed) return;
        const candidate = new AgentActivityWatchdog(settings, { onTrip });
        if (!candidate.enabled) return;
        watchdog = candidate;
        const interval = watchdogPollIntervalMs(settings);
        if (interval <= 0) return;
        timer = setInterval(() => { watchdog?.check(); }, interval);
        timer.unref?.();
    });
    return {
        recordActivity: () => { if (!closed) watchdog?.recordActivity(); },
        observeLine: line => { if (!closed) watchdog?.observeLine(line); },
        get trip() { return accepted; },
        stop,
        settled: () => reporting,
    };
}
