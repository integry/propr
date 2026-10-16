/**
 * One bounded reconciliation attempt for a Routing suspension gap. Runs the
 * configured per-repository families with bounded concurrency, persists
 * progress after every family so a retry (or a restart) resumes instead of
 * rerunning completed side effects, then runs installation-wide families once
 * every repository has converged. An attempt never reports completion while any
 * repository or family is unreconciled.
 */

import { createHash } from 'node:crypto';
import { redactSecrets } from '../utils/secretRedaction.js';
import {
    classifyResyncError,
    type ResyncInstallationFamily,
    type ResyncRepositoryFamily,
} from './routingResumeResyncMatrix.js';
import type { ResyncCompletionEvidence } from './routingResumeResyncProtocol.js';
import type { RepositoryResyncProgress, ResumeResyncRecord } from './routingResumeResyncStore.js';

export interface ResyncRepositoryStepContext {
    repository: string;
    owner: string;
    repo: string;
    /** The suspension gap being reconciled; windows history-bounded families. */
    gapStartedAt: string;
    gapEndedAt: string | null;
    correlationId: string;
    signal: AbortSignal;
}

export interface ResyncInstallationStepContext {
    repositories: string[];
    correlationId: string;
    signal: AbortSignal;
}

export interface ResyncRepositoryStep {
    family: ResyncRepositoryFamily;
    /** Must throw on any failure: a swallowed error would acknowledge a partial reconciliation. */
    run(ctx: ResyncRepositoryStepContext): Promise<void>;
}

export interface ResyncInstallationStep {
    family: ResyncInstallationFamily;
    run(ctx: ResyncInstallationStepContext): Promise<void>;
}

/** The reconciliation matrix as executable steps, supplied by the daemon. */
export interface ResumeResyncReconciler {
    /** Currently configured/authorized repositories (`owner/name`). */
    listRepositories(): Promise<string[]> | string[];
    repositorySteps: readonly ResyncRepositoryStep[];
    installationSteps: readonly ResyncInstallationStep[];
}

export interface ResyncAttemptOptions {
    record: ResumeResyncRecord;
    reconciler: ResumeResyncReconciler;
    persist: () => Promise<void>;
    now: () => number;
    concurrency: number;
    correlationId: string;
    signal: AbortSignal;
}

export interface ResyncAttemptResult {
    complete: boolean;
    /** Earliest time GitHub allows another attempt, when rate limited. */
    rateLimitRetryAt: number | null;
    error: string | null;
}

const MAX_ERROR_LENGTH = 300;

/** Bounded, redacted error text safe for persistence and the status API. */
export function describeResyncError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactSecrets(message).slice(0, MAX_ERROR_LENGTH);
}

function normalizeRepositories(repositories: readonly string[]): string[] {
    const seen = new Map<string, string>();
    for (const raw of repositories) {
        const repository = raw.trim();
        const [owner, name, extra] = repository.split('/');
        if (!owner || !name || extra !== undefined) continue;
        if (!seen.has(repository.toLowerCase())) seen.set(repository.toLowerCase(), repository);
    }
    return [...seen.values()].sort();
}

function emptyProgress(): RepositoryResyncProgress {
    return { status: 'pending', completedFamilies: [], attempts: 0, lastError: null, updatedAt: null };
}

/** Track exactly the repositories configured now; progress for kept ones survives. */
function syncRepositories(record: ResumeResyncRecord, repositories: string[]): void {
    const next: Record<string, RepositoryResyncProgress> = {};
    for (const repository of repositories) next[repository] = record.repositories[repository] ?? emptyProgress();
    record.repositories = next;
}

function isConverged(progress: RepositoryResyncProgress): boolean {
    return progress.status === 'reconciled' || progress.status === 'inaccessible';
}

interface AttemptState {
    rateLimitRetryAt: number | null;
    error: string | null;
}

function stopRequested(opts: ResyncAttemptOptions, state: AttemptState): boolean {
    return opts.signal.aborted || state.rateLimitRetryAt !== null;
}

async function reconcileRepository(repository: string, opts: ResyncAttemptOptions, state: AttemptState): Promise<void> {
    const progress = opts.record.repositories[repository];
    const [owner, repo] = repository.split('/');
    progress.attempts += 1;
    progress.status = 'pending';
    progress.lastError = null;
    for (const step of opts.reconciler.repositorySteps) {
        if (progress.completedFamilies.includes(step.family)) continue;
        if (stopRequested(opts, state)) return;
        try {
            await step.run({
                repository, owner, repo, gapStartedAt: opts.record.gapStartedAt, gapEndedAt: opts.record.gapEndedAt,
                correlationId: opts.correlationId, signal: opts.signal,
            });
        } catch (error) {
            const classified = classifyResyncError(error, opts.now());
            progress.lastError = describeResyncError(error);
            progress.updatedAt = new Date(opts.now()).toISOString();
            progress.status = classified.kind === 'inaccessible' ? 'inaccessible' : 'failed';
            if (classified.kind === 'rate_limited') {
                state.rateLimitRetryAt = Math.max(state.rateLimitRetryAt ?? 0, classified.retryAt);
            }
            if (classified.kind !== 'inaccessible') state.error = `${repository} ${step.family}: ${progress.lastError}`;
            await opts.persist();
            return;
        }
        progress.completedFamilies.push(step.family);
        progress.updatedAt = new Date(opts.now()).toISOString();
        await opts.persist();
    }
    progress.status = 'reconciled';
    await opts.persist();
}

async function reconcileInstallation(repositories: string[], opts: ResyncAttemptOptions, state: AttemptState): Promise<boolean> {
    for (const step of opts.reconciler.installationSteps) {
        if (opts.record.installationFamilies.includes(step.family)) continue;
        if (stopRequested(opts, state)) return false;
        try {
            await step.run({ repositories, correlationId: opts.correlationId, signal: opts.signal });
        } catch (error) {
            const classified = classifyResyncError(error, opts.now());
            if (classified.kind === 'rate_limited') state.rateLimitRetryAt = classified.retryAt;
            state.error = `installation ${step.family}: ${describeResyncError(error)}`;
            return false;
        }
        opts.record.installationFamilies.push(step.family);
        await opts.persist();
    }
    return true;
}

/** Run one attempt; mutates `opts.record` and persists through `opts.persist`. */
export async function runResyncAttempt(opts: ResyncAttemptOptions): Promise<ResyncAttemptResult> {
    const state: AttemptState = { rateLimitRetryAt: null, error: null };
    const repositories = normalizeRepositories(await opts.reconciler.listRepositories());
    syncRepositories(opts.record, repositories);
    await opts.persist();

    const queue = repositories.filter(repository => !isConverged(opts.record.repositories[repository]));
    const worker = async (): Promise<void> => {
        while (queue.length > 0 && !stopRequested(opts, state)) {
            await reconcileRepository(queue.shift() as string, opts, state);
        }
    };
    const workers = Math.max(1, Math.min(opts.concurrency, queue.length));
    await Promise.all(Array.from({ length: workers }, worker));

    const repositoriesConverged = repositories.every(repository => isConverged(opts.record.repositories[repository]));
    if (!repositoriesConverged || opts.signal.aborted) {
        return { complete: false, rateLimitRetryAt: state.rateLimitRetryAt, error: state.error ?? (opts.signal.aborted ? 'aborted' : 'repositories_unreconciled') };
    }
    const installationConverged = await reconcileInstallation(repositories, opts, state);
    return {
        complete: installationConverged && !opts.signal.aborted,
        rateLimitRetryAt: state.rateLimitRetryAt,
        error: installationConverged ? null : state.error ?? 'aborted',
    };
}

/** Bounded, non-secret evidence: counts, families and a digest over outcomes. */
export function buildResyncEvidence(record: ResumeResyncRecord, reconciler: ResumeResyncReconciler): ResyncCompletionEvidence {
    const entries = Object.entries(record.repositories).sort(([a], [b]) => a.localeCompare(b));
    const outcomes = entries.map(([repository, progress]) => [repository.toLowerCase(), progress.status, [...progress.completedFamilies].sort()]);
    return {
        repositories: {
            total: entries.length,
            reconciled: entries.filter(([, progress]) => progress.status === 'reconciled').length,
            inaccessible: entries.filter(([, progress]) => progress.status === 'inaccessible').length,
        },
        families: [
            ...reconciler.repositorySteps.map(step => step.family),
            ...reconciler.installationSteps.map(step => step.family),
        ],
        attempts: record.attempts,
        digest: createHash('sha256')
            .update(JSON.stringify({ outcomes, installation: [...record.installationFamilies].sort() }))
            .digest('hex'),
    };
}
