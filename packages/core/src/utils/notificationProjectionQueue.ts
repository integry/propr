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
const PROJECTION_RETRY_BASE_DELAY_MS = 25;
const PROJECTION_RETRY_MAX_DELAY_MS = 250;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface NotificationProjectionJob {
    payload: EventPayload;
    terminal: boolean;
    entityKey?: string;
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

function projectionEntityKey(payload: EventPayload): string | undefined {
    switch (payload.eventType) {
        case TASK_LIVE_UPDATE:
        case TASK_UPDATE:
            return `task:${payload.taskId}`;
        case INDEXING_UPDATE:
            return JSON.stringify([
                'indexing',
                payload.repository.trim().toLowerCase(),
                payload.branch ?? 'HEAD',
                payload.runId ?? 'legacy',
            ]);
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

function projectionRetryDelay(attempt: number): number {
    const exponential = Math.min(
        PROJECTION_RETRY_MAX_DELAY_MS,
        PROJECTION_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
    );
    return Math.max(1, Math.floor(exponential * (0.75 + Math.random() * 0.5)));
}

export class NotificationProjectionQueue {
    private readonly queue: NotificationProjectionJob[] = [];
    private readonly drainWaiters = new Set<() => void>();
    private active = 0;
    private closing = false;

    constructor(private readonly options: NotificationProjectionQueueOptions) {
        if (typeof options.projector !== 'function') {
            throw new TypeError('projector must be a function');
        }
        if (!Number.isSafeInteger(options.maxSize) || options.maxSize <= 0) {
            throw new TypeError('maxSize must be a positive safe integer');
        }
        if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
            throw new TypeError('concurrency must be a positive safe integer');
        }
        if (!Number.isSafeInteger(options.drainTimeoutMs)
            || options.drainTimeoutMs <= 0
            || options.drainTimeoutMs > MAX_TIMER_DELAY_MS) {
            throw new TypeError('drainTimeoutMs must be a schedulable positive integer');
        }
    }

    /** Pending work is globally bounded by maxSize; active work is reported separately. */
    get queueSize(): number { return this.queue.length; }
    get activeCount(): number { return this.active; }
    get isClosing(): boolean { return this.closing; }

    enqueue(payload: EventPayload): Promise<void> | null {
        if (this.closing) return null;
        const terminal = isTerminalProjection(payload);
        const entityKey = projectionEntityKey(payload);
        if (!terminal && entityKey
            && this.queue.some((queued) => queued.terminal && queued.entityKey === entityKey)) {
            return null;
        }
        if (terminal && entityKey) this.discardSupersededNonterminal(entityKey);
        const coalesceKey = projectionCoalesceKey(payload);
        if (coalesceKey) {
            const existing = this.queue.find((job) => job.coalesceKey === coalesceKey);
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
            entityKey,
            coalesceKey,
            attempts: 0,
            resolves: [resolveCompletion]
        };
        if (this.queue.length >= this.options.maxSize) {
            const evictIndex = this.queue.findIndex((queued) => !queued.terminal);
            if (evictIndex >= 0) {
                const [evicted] = this.queue.splice(evictIndex, 1);
                this.resolveJob(evicted);
                logger.debug({
                    eventType: evicted.payload.eventType,
                    replacementEventType: payload.eventType
                }, terminal
                    ? 'Evicted low-priority notification projection for a terminal transition'
                    : 'Evicted oldest nonterminal notification projection at queue capacity');
            } else {
                // Never displace terminal transitions with liveness work. A full
                // terminal backlog remains recoverable by the durable reconciler.
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
        const result = { drained, active: this.active, queued: this.queueSize };
        if (!drained) {
            for (const job of this.queue.splice(0)) this.resolveJob(job);
        }
        return result;
    }

    private pump(): void {
        while (this.active < this.options.concurrency && this.queue.length > 0) {
            this.startJob(this.queue.shift()!);
        }
    }

    private startJob(job: NotificationProjectionJob): void {
        this.active++;
        let retry = false;
        void this.options.projector(job.payload)
            .catch(async (error) => {
                retry = !this.closing && job.attempts < 2;
                logger.warn({
                    eventType: job.payload.eventType,
                    attempt: job.attempts + 1,
                    retrying: retry,
                    error: error instanceof Error ? error.message : String(error)
                }, 'Notification projection failed');
                if (retry) {
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, projectionRetryDelay(job.attempts + 1));
                    });
                }
            })
            .finally(() => {
                this.active--;
                retry = retry && !this.closing;
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
        if (!job.terminal && job.entityKey
            && this.queue.some((queued) => queued.terminal && queued.entityKey === job.entityKey)) {
            return false;
        }
        if (job.terminal && job.entityKey) this.discardSupersededNonterminal(job.entityKey);
        if (job.coalesceKey) {
            const newer = this.queue.find((queued) => queued.coalesceKey === job.coalesceKey);
            if (newer) {
                newer.resolves.push(...job.resolves);
                return true;
            }
        }
        if (this.queue.length >= this.options.maxSize) {
            const evictIndex = this.queue.findIndex((queued) => !queued.terminal);
            // A retry is older than every newly queued heartbeat, so do not
            // displace fresher same-priority liveness work at capacity.
            if (evictIndex < 0) return false;
            const [evicted] = this.queue.splice(evictIndex, 1);
            this.resolveJob(evicted);
        }
        if (job.terminal) this.queue.unshift(job);
        else this.queue.push(job);
        return true;
    }

    private discardSupersededNonterminal(entityKey: string): void {
        for (let index = this.queue.length - 1; index >= 0; index--) {
            const queued = this.queue[index];
            if (queued.terminal || queued.entityKey !== entityKey) continue;
            this.queue.splice(index, 1);
            this.resolveJob(queued);
            logger.debug({ eventType: queued.payload.eventType, entityKey },
                'Discarded nonterminal projection superseded by a terminal transition');
        }
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
