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
 * reconciliation. Frame handling is serialized; reconciliation runs outside that
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
} from './routingResumeResyncProtocol.js';
import { buildResyncEvidence, describeResyncError, runResyncAttempt, type ResumeResyncReconciler } from './routingResumeResyncRun.js';
import type { ResumeResyncRecord, ResumeResyncStore } from './routingResumeResyncStore.js';
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
                await this.persist(record);
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
            gapEndedAt: required ? frame.gapEndedAt : null,
            attempts: 0, startedAt: null, lastAttemptAt: null, nextRetryAt: null, lastError: null,
            repositories: {}, installationFamilies: [], consecutiveFailures: 0,
            completion: null, acknowledgedAt: null, updatedAt: new Date(this.now()).toISOString(),
        };
        this.lastCompletionSentAt = null;
        await this.persist(this.record);
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
                await this.persist(record);
                this.scheduleRun(0);
                return;
            case 'failed':
                record.state = 'reconciling';
                record.consecutiveFailures = 0;
                await this.persist(record);
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
                // completed/acknowledged: our completion response was lost.
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
        await this.persist(record);
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
            // Retries are scheduled only once the attempt released the run slot.
            if (this.record === record && record.state === 'partial') this.scheduleRun(this.delayUntil(record.nextRetryAt));
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
        await this.persist(record);
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
        await this.persist(record);
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
            this.settlePartial(record, `persist_completion: ${describeResyncError(error)}`, null);
            return;
        }
        logger.info({ ...generationLog(record), evidence: record.completion.evidence }, 'Routing suspension gap reconciled');
        this.sendCompletion();
    }

    private settlePartial(record: ResumeResyncRecord, error: string, rateLimitRetryAt: number | null): void {
        record.consecutiveFailures += 1;
        record.lastError = error.slice(0, MAX_PERSISTED_ERROR_LENGTH);
        if (record.consecutiveFailures >= this.maxConsecutiveFailures) {
            record.state = 'failed';
            record.nextRetryAt = null;
            logger.error({ ...generationLog(record), error }, 'Routing resume resync failed; waiting for a new resync_required or restart');
            return;
        }
        const backoff = Math.min(this.retryBaseDelayMs * 2 ** (record.consecutiveFailures - 1), this.retryMaxDelayMs);
        const retryAt = Math.max(this.now() + backoff, rateLimitRetryAt ?? 0);
        record.state = 'partial';
        record.nextRetryAt = new Date(retryAt).toISOString();
        logger.warn({ ...generationLog(record), error, nextRetryAt: record.nextRetryAt }, 'Routing resume resync partial; retrying');
    }

    private sendCompletion(): void {
        const record = this.record;
        if (!record?.completion || record.gapEndedAt === null || !this.sender) return;
        const frame = buildResyncCompleteFrame(record, { gapStartedAt: record.gapStartedAt, gapEndedAt: record.gapEndedAt }, record.completion);
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
        await drainWithTimeout([running.promise], this.stopTimeoutMs, () =>
            logger.warn({ timeoutMs: this.stopTimeoutMs }, 'Routing resume-resync attempt did not yield before the deadline'));
        if (this.running === running) this.running = null;
    }

    private delayUntil(iso: string | null): number {
        return iso ? Math.max(0, Date.parse(iso) - this.now()) : 0;
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
