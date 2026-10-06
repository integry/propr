import { classifyAgentOutputLine } from './agentOutputActivity.js';

/** Resolved watchdog thresholds. `0` disables the corresponding rule. */
export interface AgentWatchdogSettings {
    /** Longest silence allowed while no tool call is running. */
    stallTimeoutMs: number;
    /** Longest silence allowed after a tool call started without streaming output. */
    toolStallTimeoutMs: number;
    /** Consecutive whitespace-only text deltas that end the run. */
    degenerateOutputLimit: number;
}

export type AgentWatchdogRule = 'inactivity' | 'tool_inactivity' | 'degenerate_output';
export type AgentWatchdogTerminationReason = 'stalled' | 'degenerate_output';

export interface AgentWatchdogTrip {
    rule: AgentWatchdogRule;
    terminationReason: AgentWatchdogTerminationReason;
    /** Threshold that was exceeded: milliseconds for the silence rules, a delta count for degenerate output. */
    threshold: number;
    silentSeconds?: number;
    degenerateDeltas?: number;
    message: string;
}

interface AgentActivityWatchdogOptions {
    now?: () => number;
    onTrip: (trip: AgentWatchdogTrip) => void;
}

/** Prefix shared by every trip message; termination parsing relies on it. */
export const AGENT_WATCHDOG_MESSAGE_PREFIX = 'Agent watchdog stopped the run';

export function describeAgentWatchdogTrip(trip: Omit<AgentWatchdogTrip, 'message'>): string {
    if (trip.rule === 'degenerate_output') {
        return `${AGENT_WATCHDOG_MESSAGE_PREFIX} (degenerate_output): the agent produced ${trip.degenerateDeltas} consecutive whitespace-only text deltas (limit ${trip.threshold}).`;
    }
    const scope = trip.rule === 'tool_inactivity' ? 'a running tool call' : 'the agent';
    return `${AGENT_WATCHDOG_MESSAGE_PREFIX} (stalled): no output from ${scope} for ${trip.silentSeconds}s (threshold ${Math.round(trip.threshold / 1000)}s).`;
}

/**
 * Tracks the last meaningful output of one running agent and decides when it
 * has stalled or degenerated. Pure state: the caller feeds output and polls
 * {@link check}; the trip callback fires at most once.
 */
export class AgentActivityWatchdog {
    private readonly now: () => number;
    private readonly onTrip: (trip: AgentWatchdogTrip) => void;
    private lastActivityAt: number;
    private openTools = 0;
    private whitespaceDeltas = 0;
    private tripped: AgentWatchdogTrip | null = null;

    constructor(private readonly settings: AgentWatchdogSettings, options: AgentActivityWatchdogOptions) {
        this.now = options.now ?? Date.now;
        this.onTrip = options.onTrip;
        this.lastActivityAt = this.now();
    }

    get trip(): AgentWatchdogTrip | null { return this.tripped; }

    get enabled(): boolean {
        return this.settings.stallTimeoutMs > 0 || this.settings.degenerateOutputLimit > 0;
    }

    /** Any output from the container: a record, a partial record, a log line. */
    recordActivity(): void {
        this.lastActivityAt = this.now();
    }

    recordToolStart(): void {
        this.recordActivity();
        this.openTools += 1;
        this.whitespaceDeltas = 0;
    }

    recordToolEnd(): void {
        this.recordActivity();
        this.openTools = Math.max(0, this.openTools - 1);
        this.whitespaceDeltas = 0;
    }

    /** Empty deltas are protocol noise and neither count nor reset the degenerate run. */
    recordTextDelta(text: string): void {
        this.recordActivity();
        if (text.length === 0) return;
        // Text from the model means any tool it was waiting on has returned.
        this.openTools = 0;
        if (text.trim().length > 0) {
            this.whitespaceDeltas = 0;
            return;
        }
        this.whitespaceDeltas += 1;
        const limit = this.settings.degenerateOutputLimit;
        if (limit > 0 && this.whitespaceDeltas >= limit) {
            this.fire({ rule: 'degenerate_output', terminationReason: 'degenerate_output', threshold: limit, degenerateDeltas: this.whitespaceDeltas });
        }
    }

    /** Classifies one complete output line and records it. */
    observeLine(line: string): void {
        const activity = classifyAgentOutputLine(line);
        if (activity.kind === 'text') this.recordTextDelta(activity.text);
        else if (activity.kind === 'tool_start') this.recordToolStart();
        else if (activity.kind === 'tool_end') this.recordToolEnd();
        else this.recordActivity();
    }

    /** Silence threshold currently in force, or 0 when silence never trips. */
    currentThresholdMs(): number {
        const { stallTimeoutMs, toolStallTimeoutMs } = this.settings;
        if (stallTimeoutMs <= 0) return 0;
        if (this.openTools === 0) return stallTimeoutMs;
        return toolStallTimeoutMs > 0 ? Math.max(stallTimeoutMs, toolStallTimeoutMs) : 0;
    }

    check(): AgentWatchdogTrip | null {
        if (this.tripped) return this.tripped;
        const threshold = this.currentThresholdMs();
        if (threshold <= 0) return null;
        const silentMs = this.now() - this.lastActivityAt;
        if (silentMs < threshold) return null;
        return this.fire({
            rule: this.openTools > 0 ? 'tool_inactivity' : 'inactivity',
            terminationReason: 'stalled',
            threshold,
            silentSeconds: Math.floor(silentMs / 1000),
        });
    }

    private fire(trip: Omit<AgentWatchdogTrip, 'message'>): AgentWatchdogTrip {
        if (this.tripped) return this.tripped;
        this.tripped = { ...trip, message: describeAgentWatchdogTrip(trip) };
        this.onTrip(this.tripped);
        return this.tripped;
    }
}

/** How often a running watchdog polls; bounded so short test thresholds still trip promptly. */
export function watchdogPollIntervalMs(settings: AgentWatchdogSettings): number {
    const thresholds = [settings.stallTimeoutMs, settings.toolStallTimeoutMs].filter(value => value > 0);
    if (thresholds.length === 0) return 0;
    return Math.max(10, Math.min(5_000, Math.floor(Math.min(...thresholds) / 4)));
}
