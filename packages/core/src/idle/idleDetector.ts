/**
 * The control-plane idle detector (issue #3770): turns the collected signals
 * into "idle or not, and why not", and tracks for how long the instance has
 * been idle. Pure apart from the injected clock, so every signal is unit
 * tested on its own.
 *
 * The instance is idle only when every signal is quiet AND nothing scheduled
 * is due within the shutdown window. A signal that could not be read counts
 * as a blocker: idle shutdown fails safe and keeps the instance running.
 */

import type { IdleBlocker, ScheduledItem } from '@propr/shared';

export interface IdleQueueCounts {
    name: string;
    waiting: number;
    active: number;
    prioritized: number;
    waitingChildren: number;
    paused: number;
}

/** Everything the detector looks at, gathered by `collectIdleSignals`. */
export interface IdleSignals {
    /** Every BullMQ queue found in Redis. */
    queues: IdleQueueCounts[];
    /** Agent runs (any runtime) that are queued or executing. */
    activeAgentRuns: number;
    /** Open Web UI / Socket.IO sessions across API processes. */
    uiSessions: number;
    /** MCP requests being handled across API processes. */
    mcpRequests: number;
    /** Other HTTP requests being handled across API processes. */
    httpRequests: number;
    /** Follow-up handoffs still owned by a worker. */
    followupHandoffs: number;
    /** Connect deliveries received but not yet acknowledged. */
    connectDeliveries: number;
    /** Goals that are running. */
    runningGoals: number;
    /** Ultrafix loops waiting on CI or holding a claimed step. */
    ultrafixLoops: number;
    /** Scheduled items and when they are due. */
    scheduled: ScheduledItem[];
    /**
     * Polling intake is running. It always blocks: the poll timer runs on its
     * own cadence and is not stopped by a drain, so no observation-time
     * deadline can describe the next poll (and a stop would miss it).
     */
    pollingIntake: boolean;
    /**
     * Control-plane processes idle shutdown cannot stop and start again
     * together with this one: a daemon running as its own process, or an API
     * or worker process outside the composed (all-in-one) process. Each one
     * always blocks: a process that exited 0 for a stop that was then called
     * off would stay stopped while the rest restarted.
     */
    separateProcesses: string[];
    /** Signals that could not be read; each keeps the instance awake. */
    unavailable: string[];
    /** Most recent request or other activity (epoch ms); the idle period cannot start before it. */
    lastActivityAt: number | null;
}

export interface IdleEvaluation {
    idle: boolean;
    blockers: IdleBlocker[];
    /** The earliest due scheduled item, or null. */
    nextDueAt: number | null;
    /** Scheduled items, earliest first (at most {@link MAX_REPORTED_SCHEDULED}). */
    nextDue: ScheduledItem[];
}

export const MAX_REPORTED_SCHEDULED = 5;

export function emptyIdleSignals(): IdleSignals {
    return {
        queues: [], activeAgentRuns: 0, uiSessions: 0, mcpRequests: 0, httpRequests: 0, followupHandoffs: 0,
        connectDeliveries: 0, runningGoals: 0, ultrafixLoops: 0, scheduled: [], pollingIntake: false, separateProcesses: [], unavailable: [],
        lastActivityAt: null,
    };
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function queueBlockers(queues: IdleQueueCounts[]): IdleBlocker[] {
    const blockers: IdleBlocker[] = [];
    for (const queue of queues) {
        const pending = queue.waiting + queue.prioritized + queue.paused + queue.waitingChildren;
        if (queue.active > 0 || pending > 0) {
            const parts = [queue.active > 0 ? `${queue.active} active` : '', pending > 0 ? `${pending} queued` : ''].filter(Boolean);
            blockers.push({ signal: 'queue_jobs', detail: `${queue.name}: ${parts.join(', ')}` });
        }
    }
    return blockers;
}

function countBlockers(signals: IdleSignals): IdleBlocker[] {
    const counts: Array<[IdleBlocker['signal'], number, string]> = [
        ['agent_runs', signals.activeAgentRuns, 'active agent run'],
        ['ui_sessions', signals.uiSessions, 'open Web UI session'],
        ['mcp_requests', signals.mcpRequests, 'in-flight MCP request'],
        ['http_requests', signals.httpRequests, 'in-flight HTTP request'],
        ['followup_handoffs', signals.followupHandoffs, 'pending follow-up handoff'],
        ['connect_deliveries', signals.connectDeliveries, 'Connect delivery being processed'],
        ['goals', signals.runningGoals, 'running goal'],
        ['ultrafix_loops', signals.ultrafixLoops, 'Ultrafix loop waiting'],
    ];
    return counts.filter(([, count]) => count > 0).map(([signal, count, noun]) => ({ signal, detail: plural(count, noun) }));
}

/**
 * Evaluate one snapshot. `windowMs` is the shutdown window: a scheduled item
 * due within it keeps the instance awake, because stopping would only mean
 * starting again moments later (and risk missing the slot).
 */
export function evaluateIdle(signals: IdleSignals, options: { now: number; windowMs: number }): IdleEvaluation {
    const nextDue = [...signals.scheduled].sort((a, b) => a.dueAt - b.dueAt);
    const blockers: IdleBlocker[] = [
        ...signals.unavailable.map(detail => ({ signal: 'unavailable' as const, detail: `could not read ${detail}` })),
        ...queueBlockers(signals.queues),
        ...countBlockers(signals),
        ...(signals.pollingIntake ? [{ signal: 'scheduled_work' as const, detail: 'GitHub polling intake (polls on an interval; polling intake never idles)' }] : []),
        ...signals.separateProcesses.map(detail => ({ signal: 'separate_processes' as const, detail })),
    ];
    const horizon = options.now + options.windowMs;
    for (const item of nextDue) {
        if (item.dueAt > horizon) break;
        const when = item.dueAt <= options.now ? 'due now' : `due in ${Math.ceil((item.dueAt - options.now) / 1000)}s`;
        blockers.push({ signal: 'scheduled_work', detail: `${item.detail} (${when})` });
    }
    return {
        idle: blockers.length === 0,
        blockers,
        nextDueAt: nextDue[0]?.dueAt ?? null,
        nextDue: nextDue.slice(0, MAX_REPORTED_SCHEDULED),
    };
}

/**
 * Tracks continuous idleness across ticks. Any non-idle evaluation resets
 * the clock; the instance may stop once it has been idle for `afterMs`.
 */
export class IdleClock {
    private idleSince: number | null = null;

    constructor(private readonly startedAt: number) {}

    /**
     * Record an evaluation; returns when the idle period began, or null.
     * `lastActivityAt` (a request seen between ticks) moves the start forward.
     */
    observe(idle: boolean, now: number, lastActivityAt: number | null = null): number | null {
        if (!idle) {
            this.idleSince = null;
            return null;
        }
        // A fresh start is not proof of idleness for the time before it.
        const floor = Math.max(this.startedAt, Math.min(lastActivityAt ?? 0, now));
        this.idleSince = Math.max(this.idleSince ?? now, floor);
        return this.idleSince;
    }

    get since(): number | null {
        return this.idleSince;
    }

    reset(): void {
        this.idleSince = null;
    }

    /** Whether the instance has been idle for at least `afterMs`. */
    isDue(now: number, afterMs: number): boolean {
        return this.idleSince !== null && now - this.idleSince >= afterMs;
    }
}
