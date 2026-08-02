import {
    DRAFT_UPDATE,
    INDEXING_UPDATE,
    TASK_LIVE_UPDATE,
    TASK_UPDATE,
    type EventPayload
} from '@propr/shared';
import logger from './logger.js';

interface NotificationProjectionJob {
    payload: EventPayload;
    terminal: boolean;
    coalesceKey?: string;
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
            return ['completed', 'failed', 'cancelled'].includes(payload.state);
        case INDEXING_UPDATE:
            return ['completed', 'failed', 'idle'].includes(payload.phase);
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
            return `task-state:${payload.taskId}`;
        case INDEXING_UPDATE:
            return `indexing:${payload.repository}:${payload.branch ?? 'HEAD'}:${payload.runId ?? 'legacy'}`;
        case DRAFT_UPDATE:
            return `draft:${payload.draftId}`;
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
    private readonly drainWaiters = new Set<() => void>();
    private active = 0;
    private closing = false;

    constructor(private readonly options: NotificationProjectionQueueOptions) {}

    get queueSize(): number { return this.queue.length; }
    get activeCount(): number { return this.active; }
    get isClosing(): boolean { return this.closing; }

    enqueue(payload: EventPayload): Promise<void> | null {
        if (this.closing) return null;
        const terminal = isTerminalProjection(payload);
        const coalesceKey = terminal ? undefined : projectionCoalesceKey(payload);
        if (coalesceKey) {
            const existing = this.queue.find((job) => job.coalesceKey === coalesceKey);
            if (existing) {
                if (shouldReplaceCoalescedPayload(existing.payload, payload)) existing.payload = payload;
                return new Promise<void>((resolve) => existing.resolves.push(resolve));
            }
        }
        let resolveCompletion!: () => void;
        const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
        const job: NotificationProjectionJob = {
            payload,
            terminal,
            coalesceKey,
            resolves: [resolveCompletion]
        };
        const saturated = this.queue.length + this.active >= this.options.maxSize;
        if (saturated && !terminal) return null;
        if (saturated) {
            const evictIndex = this.queue.findLastIndex((queued) => !queued.terminal);
            if (evictIndex >= 0) {
                const [evicted] = this.queue.splice(evictIndex, 1);
                this.resolveJob(evicted);
                logger.debug({ eventType: evicted.payload.eventType },
                    'Coalesced low-priority notification projection for a terminal transition');
            }
            // If all in-flight and queued work is terminal, temporarily exceed
            // the soft queue bound rather than losing a durable transition. The
            // normal concurrency limit still controls projector execution.
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
        if (this.active === 0 && this.queue.length === 0) {
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
        const result = { drained, active: this.active, queued: this.queue.length };
        if (!drained) for (const job of this.queue.splice(0)) this.resolveJob(job);
        return result;
    }

    private pump(): void {
        while (this.active < this.options.concurrency && this.queue.length > 0) {
            this.startJob(this.queue.shift()!);
        }
    }

    private startJob(job: NotificationProjectionJob): void {
        this.active++;
        void this.options.projector(job.payload)
            .catch((error) => logger.warn({
                eventType: job.payload.eventType,
                error: error instanceof Error ? error.message : String(error)
            }, 'Notification projection failed'))
            .finally(() => {
                this.active--;
                this.resolveJob(job);
                this.pump();
                this.resolveDrainWaiters();
            });
    }

    private resolveJob(job: NotificationProjectionJob): void {
        for (const resolve of job.resolves) resolve();
    }

    private resolveDrainWaiters(): void {
        if (this.active > 0 || this.queue.length > 0) return;
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
    }
}
