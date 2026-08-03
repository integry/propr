import {
    DRAFT_UPDATE,
    INDEXING_UPDATE,
    TASK_LIVE_UPDATE,
    TASK_UPDATE,
    type EventPayload
} from '@propr/shared';
import {
    indexingActivityStatus,
    isTerminalIndexingPhase,
    isTerminalTaskState,
    taskActivityStatus
} from '../services/notificationProjectionFormatting.js';
import logger from './logger.js';

const COALESCED_PROJECTION_ACCEPTED = Promise.resolve();

interface NotificationProjectionJob {
    payload: EventPayload;
    terminal: boolean;
    coalesceKey?: string;
    attempts: number;
    resolves: Array<() => void>;
}

export interface NotificationProjectionQueueOptions {
    projector: (payload: EventPayload) => Promise<void>;
    maxSize: number;
    concurrency: number;
    drainTimeoutMs: number;
}

export interface NotificationProjectionQueueCloseResult {
    drained: boolean;
    active: number;
    queued: number;
}

function isTerminalProjection(payload: EventPayload): boolean {
    switch (payload.eventType) {
        case TASK_UPDATE:
            return isTerminalTaskState(payload.state);
        case INDEXING_UPDATE:
            return isTerminalIndexingPhase(payload.phase);
        case DRAFT_UPDATE:
            return payload.status === 'completed' && payload.draftStatus === 'review';
        default:
            return false;
    }
}

function projectionCoalesceKey(payload: EventPayload): string | undefined {
    switch (payload.eventType) {
        case TASK_LIVE_UPDATE:
            return `task-live:${payload.taskId}`;
        case TASK_UPDATE:
            return isTerminalTaskState(payload.state)
                ? JSON.stringify([
                    'task-terminal',
                    payload.taskId,
                    taskActivityStatus(payload.state),
                    payload.metadata?.transitionSequence
                        ?? payload.metadata?.transitionAt
                        ?? payload.timestamp
                ])
                : `task-state:${payload.taskId}`;
        case INDEXING_UPDATE:
            return JSON.stringify([
                isTerminalIndexingPhase(payload.phase) ? 'indexing-terminal' : 'indexing',
                payload.repository,
                payload.branch ?? 'HEAD',
                payload.runId ?? 'legacy',
                ...(isTerminalIndexingPhase(payload.phase)
                    ? [indexingActivityStatus(payload.phase), payload.transitionAt ?? payload.timestamp]
                    : [])
            ]);
        case DRAFT_UPDATE:
            return payload.status === 'completed' && payload.draftStatus === 'review'
                ? `draft-terminal:${payload.draftId}:${payload.timestamp}`
                : `draft:${payload.draftId}`;
        default:
            return undefined;
    }
}

function shouldReplaceCoalescedPayload(current: EventPayload, incoming: EventPayload): boolean {
    if (current.eventType !== TASK_LIVE_UPDATE || incoming.eventType !== TASK_LIVE_UPDATE) return true;
    const currentKind = current.activityKind ?? 'progress';
    const incomingKind = incoming.activityKind ?? 'progress';
    return currentKind !== 'progress' || incomingKind === 'progress';
}

export class NotificationProjectionQueue {
    private readonly queue: NotificationProjectionJob[] = [];
    // One coalesced overflow heartbeat per source activity prevents queue
    // pressure from manufacturing a stall while the bounded primary queue is
    // occupied by other work.
    private readonly deferredHeartbeats = new Map<string, NotificationProjectionJob>();
    private readonly drainWaiters = new Set<() => void>();
    private active = 0;
    private closing = false;

    constructor(private readonly options: NotificationProjectionQueueOptions) {}

    get queueSize(): number { return this.queue.length + this.deferredHeartbeats.size; }
    get activeCount(): number { return this.active; }
    get isClosing(): boolean { return this.closing; }

    enqueue(payload: EventPayload): Promise<void> | null {
        if (this.closing) return null;
        const terminal = isTerminalProjection(payload);
        const coalesceKey = projectionCoalesceKey(payload);
        if (coalesceKey) {
            const existing = this.queue.find((job) => job.coalesceKey === coalesceKey)
                ?? this.deferredHeartbeats.get(coalesceKey);
            if (existing) {
                if (shouldReplaceCoalescedPayload(existing.payload, payload)) existing.payload = payload;
                // The original job already owns the tracked completion. Returning
                // a settled acceptance avoids accumulating one waiter per
                // duplicate while the projector is blocked.
                return COALESCED_PROJECTION_ACCEPTED;
            }
        }
        let resolveCompletion!: () => void;
        const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
        const job: NotificationProjectionJob = {
            payload,
            terminal,
            coalesceKey,
            attempts: 0,
            resolves: [resolveCompletion]
        };
        const terminalNeedsPriority = terminal
            && this.queue.length + this.active >= this.options.maxSize
            && this.queue.some((queued) => !queued.terminal);
        const saturated = this.queue.length >= this.options.maxSize || terminalNeedsPriority;
        if (saturated) {
            const evictIndex = terminal
                ? this.queue.findIndex((queued) => !queued.terminal)
                : this.queue.findIndex((queued) => queued.terminal);
            // A current heartbeat protects liveness and stalled-alert accuracy.
            // Terminal work has durable reconciliation, so it is safer to defer
            // one terminal item than to discard the only fresh activity signal.
            if (evictIndex < 0 && !terminal && coalesceKey) {
                this.deferHeartbeat(job);
                return completion;
            }
            if (evictIndex >= 0) {
                const [evicted] = this.queue.splice(evictIndex, 1);
                if (!evicted.terminal && evicted.coalesceKey) this.deferHeartbeat(evicted);
                else this.resolveJob(evicted);
                logger.debug({
                    eventType: evicted.payload.eventType,
                    replacementEventType: payload.eventType
                }, terminal
                    ? 'Deferred low-priority notification projection for a terminal transition'
                    : 'Deferred a recoverable terminal projection to retain current liveness');
            } else {
                // Terminal source transitions are recovered by the durable
                // reconciler; never let unique terminal bursts exceed the bound.
                return null;
            }
        }
        if (terminal) {
            const firstLowPriority = this.queue.findIndex((queued) => !queued.terminal);
            if (firstLowPriority === -1) this.queue.push(job);
            else this.queue.splice(firstLowPriority, 0, job);
        } else this.queue.push(job);
        this.pump();
        return completion;
    }

    async close(): Promise<NotificationProjectionQueueCloseResult> {
        this.closing = true;
        if (this.active === 0 && this.queue.length === 0 && this.deferredHeartbeats.size === 0) {
            return { drained: true, active: 0, queued: 0 };
        }
        let waiter!: () => void;
        let timeout: NodeJS.Timeout | undefined;
        const drained = await Promise.race([
            new Promise<true>((resolve) => {
                waiter = () => resolve(true);
                this.drainWaiters.add(waiter);
            }),
            new Promise<false>((resolve) => {
                timeout = setTimeout(() => resolve(false), this.options.drainTimeoutMs);
            })
        ]);
        if (timeout) clearTimeout(timeout);
        this.drainWaiters.delete(waiter);
        const result = { drained, active: this.active, queued: this.queueSize };
        if (!drained) {
            for (const job of this.queue.splice(0)) this.resolveJob(job);
            for (const job of this.deferredHeartbeats.values()) this.resolveJob(job);
            this.deferredHeartbeats.clear();
        }
        return result;
    }

    private pump(): void {
        this.promoteDeferredHeartbeats();
        while (this.active < this.options.concurrency && this.queue.length > 0) {
            this.startJob(this.queue.shift()!);
            this.promoteDeferredHeartbeats();
        }
    }

    private startJob(job: NotificationProjectionJob): void {
        this.active++;
        let retry = false;
        void this.options.projector(job.payload)
            .catch((error) => {
                retry = !this.closing && job.attempts < 2;
                logger.warn({
                    eventType: job.payload.eventType,
                    attempt: job.attempts + 1,
                    retrying: retry,
                    error: error instanceof Error ? error.message : String(error)
                }, 'Notification projection failed');
            })
            .finally(() => {
                this.active--;
                if (retry) {
                    job.attempts++;
                    retry = this.requeue(job);
                }
                if (!retry) this.resolveJob(job);
                this.pump();
                this.resolveDrainWaiters();
            });
    }

    private requeue(job: NotificationProjectionJob): boolean {
        if (this.queue.length >= this.options.maxSize) {
            // A retried heartbeat is the newest known liveness signal. Prefer
            // deferring a durably recoverable terminal transition before
            // replacing another activity's heartbeat.
            const evictIndex = job.terminal
                ? this.queue.findIndex((queued) => !queued.terminal)
                : this.queue.findIndex((queued) => queued.terminal);
            if (evictIndex < 0 && !job.terminal && job.coalesceKey) {
                this.deferHeartbeat(job);
                return true;
            }
            if (evictIndex < 0) return false;
            const [evicted] = this.queue.splice(evictIndex, 1);
            if (!evicted.terminal && evicted.coalesceKey) this.deferHeartbeat(evicted);
            else this.resolveJob(evicted);
        }
        if (job.terminal) this.queue.unshift(job);
        else this.queue.push(job);
        return true;
    }

    private deferHeartbeat(job: NotificationProjectionJob): void {
        if (!job.coalesceKey) {
            this.resolveJob(job);
            return;
        }
        const existing = this.deferredHeartbeats.get(job.coalesceKey);
        if (!existing) {
            this.deferredHeartbeats.set(job.coalesceKey, job);
            return;
        }
        if (shouldReplaceCoalescedPayload(existing.payload, job.payload)) {
            existing.payload = job.payload;
        }
        existing.resolves.push(...job.resolves);
    }

    private promoteDeferredHeartbeats(): void {
        while (this.queue.length < this.options.maxSize && this.deferredHeartbeats.size > 0) {
            const entry = this.deferredHeartbeats.entries().next().value as
                | [string, NotificationProjectionJob]
                | undefined;
            if (!entry) return;
            const [key, job] = entry;
            this.deferredHeartbeats.delete(key);
            this.queue.push(job);
        }
    }

    private resolveJob(job: NotificationProjectionJob): void {
        for (const resolve of job.resolves) resolve();
    }

    private resolveDrainWaiters(): void {
        if (this.active > 0 || this.queue.length > 0 || this.deferredHeartbeats.size > 0) return;
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
    }
}
