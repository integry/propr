/**
 * Core half of the `installation_resume_resync_v1` routing contract (see
 * routingResumeResyncProtocol.ts for the wire format).
 *
 * The coordinator owns one durable record per installation. It validates every
 * control frame against that record (stale, regressed, foreign, malformed and
 * conflicting generations fail closed and change nothing), runs bounded
 * current-state reconciliation once Routing reports the installation
 * unsuspended, and answers with an exact-generation `resync_complete` only after
 * every tracked repository (configured, or still referenced by durable local
 * work) and installation family converged. Reconnecting
 * the WebSocket never completes a resync by itself; a lost completion response
 * is answered by resending the persisted completion identity, not by rerunning
 * reconciliation. Every send path reads only a completion whose save succeeded
 * (or that was loaded from validated durable state), never the live record, so
 * a duplicate frame or reconnect during the completion write cannot leak an
 * identity that might not survive. A failed save at a control boundary is
 * exposed in `lastError` and retried, never left reconciling with no work
 * scheduled. Frame handling is serialized; reconciliation runs outside that
 * queue so a superseding generation can abort it.
 */

import { randomUUID } from 'node:crypto';
import logger, { generateCorrelationId } from '../utils/logger.js';
import { drainWithTimeout } from './routingWebSocketProtocol.js';
import {
    INSTALLATION_RESUME_RESYNC_CAPABILITY,
    buildResyncCompleteFrame,
    compareGenerations,
    parseResumeResyncFrame,
    type ResumeResyncFrame,
    type ResyncAcceptedFrame,
    type ResyncCompletion,
} from './routingResumeResyncProtocol.js';
import { buildResyncEvidence, describeResyncError, runResyncAttempt, type ResumeResyncReconciler } from './routingResumeResyncRun.js';
import { inheritedRecoveryStart, type ResumeResyncRecord, type ResumeResyncStore } from './routingResumeResyncStore.js';
import { MAX_PERSISTED_ERROR_LENGTH } from './routingResumeResyncCodec.js';
import { buildResumeResyncStatus, type RoutingResumeResyncStatus } from './routingResumeResyncStatus.js';

export type { RoutingResumeResyncStatus } from './routingResumeResyncStatus.js';

export interface RoutingResumeResyncCoordinatorOptions {
    installationId: number;
    store: ResumeResyncStore;
    reconciler: ResumeResyncReconciler;
    now?: () => number;
    /** Repositories reconciled concurrently (default 2). */
    concurrency?: number;
    /** First retry delay after a partial attempt (default 30s), doubled per failure. */
    retryBaseDelayMs?: number;
    /** Retry delay ceiling (default 15 minutes). */
    retryMaxDelayMs?: number;
    /** Partial attempts before the record turns `failed` and stops retrying (default 8). */
    maxConsecutiveFailures?: number;
    /** How long stop()/supersession waits for a running attempt to yield (default 10s). */
    stopTimeoutMs?: number;
}

/** Sends a frame over the current authenticated connection; false when not sent. */
export type ResyncFrameSender = (frame: Record<string, unknown>) => boolean;

interface FrameRejection { reason: string; frameType: string; at: string }

const RUNNABLE_STATES = new Set(['reconciling', 'partial']);

export class RoutingResumeResyncCoordinator {
    readonly capability = INSTALLATION_RESUME_RESYNC_CAPABILITY;
    private readonly installationId: number;
    private readonly store: ResumeResyncStore;
    private readonly reconciler: ResumeResyncReconciler;
    private readonly now: () => number;
    private readonly concurrency: number;
    private readonly retryBaseDelayMs: number;
    private readonly retryMaxDelayMs: number;
    private readonly maxConsecutiveFailures: number;
    private readonly stopTimeoutMs: number;

    private record: ResumeResyncRecord | null = null;
    private loaded = false;
    private stopped = false;
    private queue: Promise<void> = Promise.resolve();
    private saveChain: Promise<void> = Promise.resolve();
    private retryTimer: NodeJS.Timeout | null = null;
    private persistRetryTimer: NodeJS.Timeout | null = null;
    /** The only completion a send path may use: durably saved for `record`. */
    private durableCompletion: { record: ResumeResyncRecord; completion: ResyncCompletion } | null = null;
    private running: { promise: Promise<void>; controller: AbortController } | null = null;
    private sender: ResyncFrameSender | null = null;
    private lastRejection: FrameRejection | null = null;
    private lastCompletionSentAt: string | null = null;
    private changeListener: (() => void) | null = null;

    constructor(options: RoutingResumeResyncCoordinatorOptions) {
        this.installationId = options.installationId;
        this.store = options.store;
        this.reconciler = options.reconciler;
        this.now = options.now ?? Date.now;
        this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? 30_000;
        this.retryMaxDelayMs = options.retryMaxDelayMs ?? 15 * 60_000;
        this.maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? 8);
        this.stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    }

    /** Load persisted state and resume interrupted work (daemon restart). */
    async start(): Promise<void> {
        this.stopped = false;
        await this.enqueue(async () => {
            if (!await this.ensureLoaded() || !this.record) return;
            const record = this.record;
            if (record.state === 'failed') {
                // A restart is an explicit operator signal to try again.
                record.state = 'reconciling';
                record.consecutiveFailures = 0;
                await this.persistBoundary(record, 'restart');
            }
            if (record.state === 'reconciling') this.scheduleRun(0);
            else if (record.state === 'partial') this.scheduleRun(this.delayUntil(record.nextRetryAt));
        });
    }

    /** A new authenticated connection: resend an unaccepted completion. */
    attach(send: ResyncFrameSender): void {
        this.sender = send;
        void this.enqueue(async () => {
            if (await this.ensureLoaded() && this.record?.state === 'completed') this.sendCompletion();
        });
    }

    detach(): void {
        this.sender = null;
    }

    onChange(listener: () => void): void {
        this.changeListener = listener;
    }

    /** Handle a decoded resume-resync control frame; all failures fail closed. */
    handleFrame(frame: Record<string, unknown>, frameBytes: number): Promise<void> {
        return this.enqueue(() => this.applyFrame(frame, frameBytes));
    }

    getStatus(): RoutingResumeResyncStatus {
        return buildResumeResyncStatus(this.record, {
            installationId: this.installationId,
            running: this.running !== null,
            lastRejection: this.lastRejection,
            lastCompletionSentAt: this.lastCompletionSentAt,
        });
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.sender = null;
        this.clearPersistRetry();
        await this.abortRun();
        await this.saveChain;
    }

    private enqueue(work: () => Promise<void>): Promise<void> {
        const next = this.queue.then(work).catch((error: unknown) => {
            logger.error({ error: describeResyncError(error) }, 'Routing resume-resync handling failed');
        });
        this.queue = next;
        return next;
    }

    private async ensureLoaded(): Promise<boolean> {
        if (this.loaded) return true;
        try {
            this.record = await this.store.load(this.installationId);
            this.loaded = true;
            // The codec validated this row, so its completion is durable and sendable.
            const completion = this.record?.completion;
            if (completion && (this.record?.state === 'completed' || this.record?.state === 'acknowledged')) {
                this.durableCompletion = { record: this.record, completion: structuredClone(completion) };
            }
            return true;
        } catch (error) {
            logger.error({ error: describeResyncError(error) }, 'Failed to load persisted routing resume-resync state');
            return false;
        }
    }

    private async applyFrame(raw: Record<string, unknown>, frameBytes: number): Promise<void> {
        const parsed = parseResumeResyncFrame(raw, frameBytes);
        if (!parsed.ok) return this.reject(String(raw.type), parsed.reason);
        const frame = parsed.frame;
        if (frame.installationId !== this.installationId) return this.reject(frame.type, 'foreign_installation');
        if (!await this.ensureLoaded()) return this.reject(frame.type, 'state_unavailable');

        if (frame.type === 'resync_accepted') return this.applyAccepted(frame);
        const current = this.record;
        const order = current ? compareGenerations(frame, current) : 1;
        if (order < 0) return this.reject(frame.type, 'stale_generation');
        if (order > 0) return this.beginGeneration(frame, current);
        return this.applySameGeneration(frame, current as ResumeResyncRecord);
    }

    private async beginGeneration(frame: Exclude<ResumeResyncFrame, ResyncAcceptedFrame>, previous: ResumeResyncRecord | null): Promise<void> {
        if (previous && previous.state !== 'acknowledged') {
            logger.warn({ previous: generationLog(previous), next: generationLog(frame) },
                'Routing superseded an unacknowledged resume generation; restarting reconciliation for the newer gap');
        }
        await this.abortRun();
        const required = frame.type === 'resync_required';
        this.record = {
            installationId: frame.installationId,
            routingGeneration: frame.routingGeneration,
            resumeGeneration: frame.resumeGeneration,
            state: required ? 'reconciling' : 'pending',
            gapStartedAt: frame.gapStartedAt,
            recoveryStartedAt: inheritedRecoveryStart(previous, frame.gapStartedAt),
            gapEndedAt: required ? frame.gapEndedAt : null,
            attempts: 0, startedAt: null, lastAttemptAt: null, nextRetryAt: null, lastError: null,
            repositories: {}, installationFamilies: [], consecutiveFailures: 0,
            completion: null, acknowledgedAt: null, updatedAt: new Date(this.now()).toISOString(),
        };
        this.lastCompletionSentAt = null;
        this.durableCompletion = null;
        this.clearPersistRetry();
        await this.persistBoundary(this.record, 'generation');
        logger.info({ ...generationLog(frame), state: this.record.state }, 'Recorded routing installation resume gap');
        if (required) this.scheduleRun(0);
    }

    private async applySameGeneration(frame: Exclude<ResumeResyncFrame, ResyncAcceptedFrame>, record: ResumeResyncRecord): Promise<void> {
        if (frame.gapStartedAt !== record.gapStartedAt) return this.reject(frame.type, 'conflicting_generation');
        if (frame.type === 'resume_pending') return; // duplicate or late; never regresses state
        if (record.gapEndedAt !== null && record.gapEndedAt !== frame.gapEndedAt) {
            return this.reject(frame.type, 'conflicting_generation');
        }
        switch (record.state) {
            case 'pending':
                record.gapEndedAt = frame.gapEndedAt;
                record.state = 'reconciling';
                await this.persistBoundary(record, 'unsuspended');
                this.scheduleRun(0);
                return;
            case 'failed':
                record.state = 'reconciling';
                record.consecutiveFailures = 0;
                await this.persistBoundary(record, 'resume_failed');
                this.scheduleRun(0);
                return;
            case 'reconciling':
                if (!this.running && !this.retryTimer) this.scheduleRun(0);
                return;
            case 'partial':
                // Keep the bounded (possibly rate-limit) retry schedule.
                if (!this.running && !this.retryTimer) this.scheduleRun(this.delayUntil(record.nextRetryAt));
                return;
            default:
                // completed/acknowledged: our completion response was lost. A
                // completion whose save is still pending is not sent here.
                this.sendCompletion();
        }
    }

    private async applyAccepted(frame: ResyncAcceptedFrame): Promise<void> {
        const record = this.record;
        if (!record || compareGenerations(frame, record) !== 0) return this.reject(frame.type, 'unknown_generation');
        if (!record.completion || (record.state !== 'completed' && record.state !== 'acknowledged')) {
            return this.reject(frame.type, 'not_completed');
        }
        if (frame.completionId !== record.completion.completionId) return this.reject(frame.type, 'completion_mismatch');
        if (record.state === 'acknowledged') return;
        record.state = 'acknowledged';
        record.acknowledgedAt = new Date(this.now()).toISOString();
        await this.persistBoundary(record, 'acknowledgement');
        logger.info(generationLog(record), 'Routing accepted resume resync completion; routed intake resumes');
    }

    private reject(frameType: string, reason: string): void {
        this.lastRejection = { reason, frameType, at: new Date(this.now()).toISOString() };
        logger.warn({ frameType, reason }, 'Rejected routing resume-resync frame (fail closed)');
        this.notify();
    }

    private scheduleRun(delayMs: number): void {
        if (this.stopped || this.running) return;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.launchRun();
        }, Math.max(0, delayMs));
        this.retryTimer.unref?.();
    }

    private launchRun(): void {
        const record = this.record;
        if (this.stopped || this.running || !record || !RUNNABLE_STATES.has(record.state)) return;
        const controller = new AbortController();
        const promise = this.executeRun(record, controller).catch((error: unknown) => {
            logger.error({ error: describeResyncError(error) }, 'Routing resume-resync attempt crashed');
        }).finally(() => {
            if (this.running?.promise === promise) this.running = null;
            // Retries, and work a supersession or restart deferred while this
            // attempt drained, are scheduled only once it released the run slot.
            const next = this.record;
            const deferred = next !== record || controller.signal.aborted || next.state === 'partial';
            if (next && deferred && RUNNABLE_STATES.has(next.state)) this.scheduleRun(next.state === 'partial' ? this.delayUntil(next.nextRetryAt) : 0);
            this.notify();
        });
        this.running = { promise, controller };
    }

    private async executeRun(record: ResumeResyncRecord, controller: AbortController): Promise<void> {
        const nowIso = new Date(this.now()).toISOString();
        record.state = 'reconciling';
        record.attempts += 1;
        record.startedAt ??= nowIso;
        record.lastAttemptAt = nowIso;
        record.nextRetryAt = null;
        try {
            await this.persist(record);
        } catch (error) {
            // launchRun schedules the bounded retry once the slot is released.
            if (this.record === record && !controller.signal.aborted) {
                const exhausted = this.settlePartial(record, `persist_attempt: ${describeResyncError(error)}`, null);
                if (exhausted) this.schedulePersistRetry(record, 1, null);
            }
            return;
        }
        const correlationId = generateCorrelationId();
        logger.info({ ...generationLog(record), attempt: record.attempts, correlationId }, 'Reconciling GitHub state after routing suspension gap');

        let result;
        try {
            result = await runResyncAttempt({
                record, reconciler: this.reconciler, persist: () => this.persist(record), now: this.now,
                concurrency: this.concurrency, correlationId, signal: controller.signal,
            });
        } catch (error) {
            result = { complete: false, rateLimitRetryAt: null, error: describeResyncError(error) };
        }
        // Superseded or stopped: progress is persisted; whoever owns the record next resumes it.
        if (this.record !== record || controller.signal.aborted) return;
        if (result.complete) return this.complete(record);
        this.settlePartial(record, result.error ?? 'repositories_unreconciled', result.rateLimitRetryAt);
        // Keep the attempt's diagnosis; a partial retry re-saves, a failed record is retried.
        await this.persistBoundary(record, 'settle', false);
    }

    private async complete(record: ResumeResyncRecord): Promise<void> {
        record.completion = {
            completionId: randomUUID(),
            completedAt: new Date(this.now()).toISOString(),
            evidence: buildResyncEvidence(record, this.reconciler),
        };
        record.state = 'completed';
        record.lastError = null;
        record.consecutiveFailures = 0;
        try {
            // The identity must be durable before Routing can see it.
            await this.persist(record);
        } catch (error) {
            record.completion = null;
            const exhausted = this.settlePartial(record, `persist_completion: ${describeResyncError(error)}`, null);
            if (exhausted) this.schedulePersistRetry(record, 1, null);
            return;
        }
        // persist() skips a superseded record without writing, so only publish our own.
        if (this.record !== record || !record.completion) return;
        this.durableCompletion = { record, completion: structuredClone(record.completion) };
        logger.info({ ...generationLog(record), evidence: record.completion.evidence }, 'Routing suspension gap reconciled');
        this.sendCompletion();
    }

    /** Returns true when the retry budget is exhausted and the record turned `failed`. */
    private settlePartial(record: ResumeResyncRecord, error: string, rateLimitRetryAt: number | null): boolean {
        record.consecutiveFailures += 1;
        record.lastError = error.slice(0, MAX_PERSISTED_ERROR_LENGTH);
        if (record.consecutiveFailures >= this.maxConsecutiveFailures) {
            record.state = 'failed';
            record.nextRetryAt = null;
            logger.error({ ...generationLog(record), error }, 'Routing resume resync failed; waiting for a new resync_required or restart');
            return true;
        }
        const backoff = Math.min(this.retryBaseDelayMs * 2 ** (record.consecutiveFailures - 1), this.retryMaxDelayMs);
        const retryAt = Math.max(this.now() + backoff, rateLimitRetryAt ?? 0);
        record.state = 'partial';
        record.nextRetryAt = new Date(retryAt).toISOString();
        logger.warn({ ...generationLog(record), error, nextRetryAt: record.nextRetryAt }, 'Routing resume resync partial; retrying');
        return false;
    }

    private sendCompletion(): void {
        const record = this.record;
        const durable = this.durableCompletion;
        if (!record || durable?.record !== record || record.gapEndedAt === null || !this.sender) return;
        const frame = buildResyncCompleteFrame(record, { gapStartedAt: record.gapStartedAt, gapEndedAt: record.gapEndedAt }, durable.completion);
        if (this.sender(frame)) {
            this.lastCompletionSentAt = new Date(this.now()).toISOString();
            this.notify();
        }
    }

    private async abortRun(): Promise<void> {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        const running = this.running;
        if (!running) return;
        running.controller.abort();
        // An attempt that does not yield keeps the run slot until it settles,
        // so no later attempt overlaps its mutations of the same record.
        await drainWithTimeout([running.promise], this.stopTimeoutMs, () =>
            logger.warn({ timeoutMs: this.stopTimeoutMs }, 'Routing resume-resync attempt did not yield before the deadline'));
    }

    private delayUntil(iso: string | null): number {
        return iso ? Math.max(0, Date.parse(iso) - this.now()) : 0;
    }

    /**
     * Persist a control-boundary mutation. A failure is exposed in `lastError`;
     * a runnable record is re-saved by its next attempt (the caller schedules it),
     * any other state gets a bounded-backoff persistence retry.
     */
    private async persistBoundary(record: ResumeResyncRecord, boundary: string, expose = true): Promise<void> {
        try {
            await this.persist(record);
        } catch (error) {
            const exposed = expose ? this.recordPersistFailure(record, boundary, error) : null;
            if (!expose) logger.error({ ...generationLog(record), boundary, error: describeResyncError(error) }, 'Failed to persist routing resume-resync state; retrying');
            if (!RUNNABLE_STATES.has(record.state)) this.schedulePersistRetry(record, 1, exposed);
        }
    }

    private recordPersistFailure(record: ResumeResyncRecord, boundary: string, error: unknown): string {
        const message = `persist_${boundary}: ${describeResyncError(error)}`;
        record.lastError = message.slice(0, MAX_PERSISTED_ERROR_LENGTH);
        logger.error({ ...generationLog(record), error: message }, 'Failed to persist routing resume-resync state; retrying');
        this.notify();
        return record.lastError;
    }

    /** `exposed` is the persistence error this retry clears once a save succeeds. */
    private schedulePersistRetry(record: ResumeResyncRecord, failures: number, exposed: string | null): void {
        if (this.stopped || this.record !== record) return;
        this.clearPersistRetry();
        const delay = Math.min(this.retryBaseDelayMs * 2 ** (failures - 1), this.retryMaxDelayMs);
        this.persistRetryTimer = setTimeout(() => {
            this.persistRetryTimer = null;
            void this.enqueue(async () => {
                if (this.stopped || this.record !== record) return;
                // A recovered save clears only the persistence error it is retrying.
                if (exposed !== null && record.lastError === exposed) record.lastError = null;
                try {
                    await this.persist(record);
                } catch (error) {
                    // Never overwrite a reconciliation diagnosis (e.g. why the record failed).
                    const next = record.lastError === null ? this.recordPersistFailure(record, 'retry', error) : null;
                    if (next === null) logger.error({ ...generationLog(record), error: describeResyncError(error) }, 'Failed to persist routing resume-resync state; retrying');
                    this.schedulePersistRetry(record, failures + 1, next);
                }
            });
        }, delay);
        this.persistRetryTimer.unref?.();
    }

    private clearPersistRetry(): void {
        if (this.persistRetryTimer) clearTimeout(this.persistRetryTimer);
        this.persistRetryTimer = null;
    }

    /** Persist a snapshot in order; skipped for a record that was superseded. */
    private persist(record: ResumeResyncRecord): Promise<void> {
        if (record !== this.record) return Promise.resolve();
        record.updatedAt = new Date(this.now()).toISOString();
        const snapshot = structuredClone(record);
        const saved = this.saveChain.then(() => this.store.save(snapshot));
        this.saveChain = saved.catch(() => undefined);
        this.notify();
        return saved;
    }

    private notify(): void {
        try {
            this.changeListener?.();
        } catch (error) {
            logger.warn({ error: describeResyncError(error) }, 'Routing resume-resync status listener threw; ignoring');
        }
    }
}

function generationLog(identity: { installationId: number; routingGeneration: number; resumeGeneration: number }) {
    return {
        installationId: identity.installationId,
        routingGeneration: identity.routingGeneration,
        resumeGeneration: identity.resumeGeneration,
    };
}
