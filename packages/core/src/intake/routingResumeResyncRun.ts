/**
 * One bounded reconciliation attempt for a Routing suspension gap. Runs the
 * per-repository families with bounded concurrency, persists progress after
 * every family so a retry (or a restart) resumes instead of rerunning completed
 * side effects, then runs installation-wide families once every repository has
 * converged. An attempt never reports completion while any repository or family
 * is unreconciled.
 *
 * The repository set is the union of the currently configured repositories, the
 * repositories durable local work still references, and every repository this
 * generation already tracks, so a repository removed from configuration or
 * installation access during the gap is reconciled to a safe local terminal
 * state instead of silently disappearing. Lost access is authoritative current
 * state, not a skip: local families (task-intent invalidation) still run, and
 * only GitHub-dependent families are classified inapplicable, with the access
 * or configuration evidence recorded alongside them.
 */

import { redactSecrets } from '../utils/secretRedaction.js';
import {
    RESYNC_GITHUB_DEPENDENT_FAMILIES,
    ResyncRepositoryInaccessibleError,
    classifyResyncError,
    type ResyncInstallationFamily,
    type ResyncRepositoryFamily,
} from './routingResumeResyncMatrix.js';
import type { ResyncCompletionEvidence } from './routingResumeResyncProtocol.js';
import type { RepositoryAccess, RepositoryResyncProgress, ResumeResyncRecord } from './routingResumeResyncStore.js';
import { MAX_RESYNC_REPOSITORIES, computeResyncDigest, countResyncOutcomes, isResyncRepositoryName } from './routingResumeResyncCodec.js';

export interface ResyncRepositoryStepContext {
    repository: string;
    owner: string;
    repo: string;
    /** The suspension gap being reconciled; windows history-bounded families. */
    gapStartedAt: string;
    gapEndedAt: string | null;
    /** Access proved by `repository_access` in this generation (null before it ran). */
    access: RepositoryAccess | null;
    /** False when only durable local work (or earlier progress) still references the repository. */
    configured: boolean;
    correlationId: string;
    signal: AbortSignal;
}

/** What a step proved; `repository_access` reports the current access state. */
export interface ResyncRepositoryStepResult {
    access?: RepositoryAccess;
}

export interface ResyncInstallationStepContext {
    repositories: string[];
    /**
     * Tracked repositories that lost access or left the configuration: their
     * local work was invalidated, so GitHub-dependent installation work for
     * them is inapplicable.
     */
    unavailableRepositories: string[];
    correlationId: string;
    signal: AbortSignal;
}

export interface ResyncRepositoryStep {
    family: ResyncRepositoryFamily;
    /** Must throw on any failure: a swallowed error would acknowledge a partial reconciliation. */
    run(ctx: ResyncRepositoryStepContext): Promise<ResyncRepositoryStepResult | void>;
}

export interface ResyncInstallationStep {
    family: ResyncInstallationFamily;
    run(ctx: ResyncInstallationStepContext): Promise<void>;
}

/** The reconciliation matrix as executable steps, supplied by the daemon. */
export interface ResumeResyncReconciler {
    /** Currently configured/authorized repositories (`owner/name`). */
    listRepositories(): Promise<string[]> | string[];
    /**
     * Repositories referenced by nonterminal durable work: task intents,
     * queued/active jobs and retained withdrawal cleanups. Must throw rather
     * than return a partial list.
     */
    listReferencedRepositories(): Promise<string[]> | string[];
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

const GITHUB_DEPENDENT: ReadonlySet<string> = new Set(RESYNC_GITHUB_DEPENDENT_FAMILIES);

function normalizeRepositories(repositories: readonly string[]): string[] {
    const seen = new Map<string, string>();
    for (const raw of repositories) {
        if (typeof raw !== 'string') continue;
        const repository = raw.trim();
        if (!isResyncRepositoryName(repository)) continue;
        if (!seen.has(repository.toLowerCase())) seen.set(repository.toLowerCase(), repository);
    }
    return [...seen.values()];
}

function emptyProgress(configured: boolean): RepositoryResyncProgress {
    return {
        status: 'pending', completedFamilies: [], inapplicableFamilies: [], access: null, configured,
        attempts: 0, lastError: null, updatedAt: null,
    };
}

/** Families reconciled under a different access/configuration classification are redone. */
function reclassify(progress: RepositoryResyncProgress): void {
    progress.completedFamilies = progress.completedFamilies.filter(family => family === 'repository_access');
    progress.inapplicableFamilies = [];
    progress.status = 'pending';
}

/**
 * Track the union of configured, referenced and already-tracked repositories.
 * Exceeding the bound fails the attempt closed rather than dropping any.
 */
async function syncRepositories(record: ResumeResyncRecord, reconciler: ResumeResyncReconciler): Promise<string[]> {
    const configured = normalizeRepositories(await reconciler.listRepositories());
    const referenced = normalizeRepositories(await reconciler.listReferencedRepositories());
    const configuredKeys = new Set(configured.map(repository => repository.toLowerCase()));
    const byKey = new Map<string, string>();
    for (const repository of [...Object.keys(record.repositories), ...configured, ...referenced]) {
        if (!byKey.has(repository.toLowerCase())) byKey.set(repository.toLowerCase(), repository);
    }
    if (byKey.size > MAX_RESYNC_REPOSITORIES) {
        throw new Error(`repository_set_exceeds_bound: ${byKey.size} repositories (max ${MAX_RESYNC_REPOSITORIES})`);
    }
    for (const [key, repository] of byKey) {
        const isConfigured = configuredKeys.has(key);
        const progress = record.repositories[repository];
        if (!progress) {
            record.repositories[repository] = emptyProgress(isConfigured);
        } else if (progress.configured !== isConfigured) {
            progress.configured = isConfigured;
            reclassify(progress);
        }
    }
    return [...byKey.values()].sort();
}

function isSettled(progress: RepositoryResyncProgress, family: string): boolean {
    return progress.completedFamilies.includes(family) || progress.inapplicableFamilies.includes(family);
}

function isConverged(progress: RepositoryResyncProgress, reconciler: ResumeResyncReconciler): boolean {
    return (progress.status === 'reconciled' || progress.status === 'inaccessible')
        && reconciler.repositorySteps.every(step => isSettled(progress, step.family));
}

/** Record the proved access; a changed classification invalidates families reconciled under the old one. */
function recordAccess(progress: RepositoryResyncProgress, access: RepositoryAccess): void {
    if (progress.access !== null && progress.access !== access) reclassify(progress);
    progress.access = access;
}

function inapplicable(progress: RepositoryResyncProgress, family: string): boolean {
    return GITHUB_DEPENDENT.has(family) && (progress.access === 'inaccessible' || !progress.configured);
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
    const touch = () => { progress.updatedAt = new Date(opts.now()).toISOString(); };
    progress.attempts += 1;
    progress.status = 'pending';
    progress.lastError = null;
    for (const step of opts.reconciler.repositorySteps) {
        if (isSettled(progress, step.family)) continue;
        if (stopRequested(opts, state)) return;
        if (inapplicable(progress, step.family)) {
            // Evidence: `access`/`configured` persist alongside the classification.
            progress.inapplicableFamilies.push(step.family);
            touch();
            await opts.persist();
            continue;
        }
        let result: ResyncRepositoryStepResult | void;
        try {
            result = await step.run({
                repository, owner, repo, gapStartedAt: opts.record.gapStartedAt, gapEndedAt: opts.record.gapEndedAt,
                access: progress.access, configured: progress.configured, correlationId: opts.correlationId, signal: opts.signal,
            });
        } catch (error) {
            if (step.family === 'repository_access' && error instanceof ResyncRepositoryInaccessibleError) {
                result = { access: 'inaccessible' };
            } else {
                const classified = classifyResyncError(error, opts.now());
                progress.lastError = describeResyncError(error);
                progress.status = 'failed';
                touch();
                if (classified.kind === 'rate_limited') {
                    state.rateLimitRetryAt = Math.max(state.rateLimitRetryAt ?? 0, classified.retryAt);
                }
                // A GitHub "not found" after access was proved may be access lost
                // meanwhile: re-prove it before the next attempt.
                if ((error as { status?: unknown } | null)?.status === 404) {
                    progress.completedFamilies = progress.completedFamilies.filter(family => family !== 'repository_access');
                }
                state.error = `${repository} ${step.family}: ${progress.lastError}`;
                await opts.persist();
                return;
            }
        }
        if (step.family === 'repository_access') recordAccess(progress, result?.access ?? 'accessible');
        progress.completedFamilies.push(step.family);
        touch();
        await opts.persist();
    }
    progress.status = progress.access === 'inaccessible' ? 'inaccessible' : 'reconciled';
    await opts.persist();
}

async function reconcileInstallation(repositories: string[], opts: ResyncAttemptOptions, state: AttemptState): Promise<boolean> {
    const unavailableRepositories = repositories.filter(repository => {
        const progress = opts.record.repositories[repository];
        return progress.access === 'inaccessible' || !progress.configured;
    });
    for (const step of opts.reconciler.installationSteps) {
        if (opts.record.installationFamilies.includes(step.family)) continue;
        if (stopRequested(opts, state)) return false;
        try {
            await step.run({ repositories, unavailableRepositories, correlationId: opts.correlationId, signal: opts.signal });
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
    const repositories = await syncRepositories(opts.record, opts.reconciler);
    await opts.persist();

    const queue = repositories.filter(repository => !isConverged(opts.record.repositories[repository], opts.reconciler));
    const worker = async (): Promise<void> => {
        while (queue.length > 0 && !stopRequested(opts, state)) {
            await reconcileRepository(queue.shift() as string, opts, state);
        }
    };
    const workers = Math.max(1, Math.min(opts.concurrency, queue.length));
    await Promise.all(Array.from({ length: workers }, worker));

    const repositoriesConverged = Object.values(opts.record.repositories).every(progress => isConverged(progress, opts.reconciler));
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
    return {
        repositories: countResyncOutcomes(record.repositories),
        families: [
            ...reconciler.repositorySteps.map(step => step.family),
            ...reconciler.installationSteps.map(step => step.family),
        ],
        attempts: record.attempts,
        digest: computeResyncDigest(record),
    };
}
