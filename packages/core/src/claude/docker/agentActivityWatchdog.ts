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
    /**
     * Running tool calls the provider identified, keyed by call id, and those
     * already finished (records may be seen twice). Each running call keeps the
     * scope (model message, or output line) that declared it.
     */
    private readonly openToolIds = new Map<string, string | undefined>();
    private readonly finishedToolIds = new Set<string>();
    /** Scopes of the running tool calls reported without an id, oldest first. */
    private readonly anonymousTools: (string | undefined)[] = [];
    /** Model message the latest identified record belonged to. */
    private currentMessageId: string | undefined;
    private lineCount = 0;
    private whitespaceDeltas = 0;
    private tripped: AgentWatchdogTrip | null = null;

    constructor(private settings: AgentWatchdogSettings, options: AgentActivityWatchdogOptions) {
        this.now = options.now ?? Date.now;
        this.onTrip = options.onTrip;
        this.lastActivityAt = this.now();
    }

    get trip(): AgentWatchdogTrip | null { return this.tripped; }

    get enabled(): boolean {
        const { stallTimeoutMs, toolStallTimeoutMs, degenerateOutputLimit } = this.settings;
        return stallTimeoutMs > 0 || toolStallTimeoutMs > 0 || degenerateOutputLimit > 0;
    }

    /** Number of tool calls currently running. */
    get openTools(): number {
        return this.openToolIds.size + this.anonymousTools.length;
    }

    /**
     * Applies thresholds that became known after output started arriving.
     * Activity and tool state observed so far are kept, so a run observed under
     * all-zero placeholder settings is judged exactly as if they applied from the start.
     */
    configure(settings: AgentWatchdogSettings): void {
        this.settings = settings;
        this.checkDegenerate();
    }

    /** Any output from the container: a record, a partial record, a log line. */
    recordActivity(): void {
        this.lastActivityAt = this.now();
    }

    /** `scope` identifies the model message (or output line) declaring the call; its own text does not end it. */
    recordToolStart(id?: string, scope?: string): void {
        this.recordActivity();
        this.whitespaceDeltas = 0;
        if (id === undefined) this.anonymousTools.push(scope);
        else if (!this.finishedToolIds.has(id) && !this.openToolIds.has(id)) this.openToolIds.set(id, scope);
    }

    recordToolEnd(id?: string): void {
        this.recordActivity();
        this.whitespaceDeltas = 0;
        if (id !== undefined && this.openToolIds.delete(id)) { this.finishedToolIds.add(id); return; }
        // A repeated end of a finished call must not close another one.
        if (id !== undefined && this.finishedToolIds.has(id)) return;
        if (id !== undefined) this.finishedToolIds.add(id);
        if (this.anonymousTools.length > 0) { this.anonymousTools.shift(); return; }
        // An end without an id closes the oldest identified call.
        if (id === undefined) {
            const oldest = this.openToolIds.keys().next();
            if (!oldest.done) this.recordToolEnd(oldest.value);
        }
    }

    /**
     * Empty deltas are protocol noise and neither count nor reset the degenerate run.
     * `scope` identifies the model message (or output line) the text belongs to.
     */
    recordTextDelta(text: string, scope?: string): void {
        this.recordActivity();
        if (text.length === 0) return;
        // Text from the model means any tool it was waiting on has returned;
        // text accompanying a call in its declaring message does not.
        const declaredHere = (toolScope: string | undefined) => scope !== undefined && toolScope === scope;
        for (const [id, toolScope] of this.openToolIds) {
            if (declaredHere(toolScope)) continue;
            this.openToolIds.delete(id);
            this.finishedToolIds.add(id);
        }
        const remaining = this.anonymousTools.filter(declaredHere);
        this.anonymousTools.splice(0, this.anonymousTools.length, ...remaining);
        if (text.trim().length > 0) {
            this.whitespaceDeltas = 0;
            return;
        }
        this.whitespaceDeltas += 1;
        this.checkDegenerate();
    }

    /** Classifies one complete output line and records every transition in it. */
    observeLine(line: string): void {
        this.lineCount += 1;
        const lineScope = `line:${this.lineCount}`;
        for (const activity of classifyAgentOutputLine(line)) {
            if (activity.kind !== 'tool_end' && activity.messageId) this.currentMessageId = activity.messageId;
            // Unidentified records scope their transitions to the line itself.
            const scope = activity.kind === 'tool_end' ? undefined : activity.messageId ?? this.currentMessageId ?? lineScope;
            if (activity.kind === 'text') this.recordTextDelta(activity.text, scope);
            else if (activity.kind === 'tool_start') this.recordToolStart(activity.id, scope);
            else if (activity.kind === 'tool_end') this.recordToolEnd(activity.id);
            else this.recordActivity();
        }
    }

    /** Silence threshold currently in force, or 0 when silence never trips. */
    currentThresholdMs(): number {
        const { stallTimeoutMs, toolStallTimeoutMs } = this.settings;
        if (this.openTools === 0) return Math.max(stallTimeoutMs, 0);
        // Each rule stands alone: a disabled ordinary threshold leaves the tool one in force.
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

    private checkDegenerate(): void {
        const limit = this.settings.degenerateOutputLimit;
        if (limit > 0 && this.whitespaceDeltas >= limit) {
            this.fire({ rule: 'degenerate_output', terminationReason: 'degenerate_output', threshold: limit, degenerateDeltas: this.whitespaceDeltas });
        }
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
