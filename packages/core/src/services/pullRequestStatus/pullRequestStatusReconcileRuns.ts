import logger from '../../utils/logger.js';
import type {
    PullRequestListCursor,
    PullRequestStatusBackfillResult,
    PullRequestStatusBackfillWork,
    PullRequestStatusBasePushResult,
} from './pullRequestStatusReconcile.js';

/**
 * The reconciliation enumerations (pullRequestStatusReconcile) run batch by
 * batch until they are complete: the startup backfill, and the listing of the
 * open pull requests into a pushed branch. What a batch's budget left is read
 * by the next batch, from where it stopped, once the batch's updates have
 * started; a batch that fails is retried on the bounded schedule.
 */

export interface PullRequestStatusReconcileRunner {
    /** Status maintenance is still enabled in this process. */
    enabled: () => boolean;
    /** The bounded retry schedule of a failed batch. */
    retryDelaysMs: () => readonly number[];
    /** How long a push waits before its listing, so a burst of pushes costs one. */
    debounceMs: number;
    backfill: (work?: PullRequestStatusBackfillWork[]) => Promise<PullRequestStatusBackfillResult>;
    refreshForBasePush: (push: { repository: string; branch: string; sha: string; from: PullRequestListCursor | null }) => Promise<PullRequestStatusBasePushResult>;
}

// --- Startup backfill ---

/** Pending backfill batches: retries of failed listings and the rest of the enumeration. */
const backfillTimers = new Set<NodeJS.Timeout>();
/** Changes when the runs stop, so a batch still running then schedules no further batch. */
let generation = 0;

function armBackfill(runner: PullRequestStatusReconcileRunner, attempt: number, work: PullRequestStatusBackfillWork[] | undefined, delayMs: number): void {
    const timer = setTimeout(() => {
        backfillTimers.delete(timer);
        runBackfill(runner, attempt, work);
    }, delayMs);
    timer.unref?.();
    backfillTimers.add(timer);
}

/**
 * One backfill batch, from `work` (every monitored repository when absent).
 * The work the batch budget left is deferred, not failed: it runs as the next
 * batch however many retries came before. A repository whose open pull
 * requests could not be listed (or every one, when the monitored repositories
 * could not be read) is listed again, from where it was, on the bounded
 * schedule: a failure proves nothing about its pull requests.
 */
function runBackfill(runner: PullRequestStatusReconcileRunner, attempt: number, work?: PullRequestStatusBackfillWork[]): void {
    const started = generation;
    void runner.backfill(work)
        .then(result => result, error => {
            logger.warn({ error: (error as Error).message }, 'Failed to read the repositories for the pull request status backfill');
            return null;
        })
        .then(result => {
            if (!runner.enabled() || started !== generation) return;
            if (result && result.remaining.length > 0) armBackfill(runner, 0, result.remaining, result.resumeAfterMs);
            const failed = result ? result.failed : work;
            const delay = runner.retryDelaysMs()[attempt];
            if ((failed && failed.length === 0) || delay === undefined) return;
            armBackfill(runner, attempt + 1, failed, delay);
        });
}

/** Starts the backfill of every open ProPR pull request in the monitored repositories. */
export function startPullRequestStatusBackfillRun(runner: PullRequestStatusReconcileRunner): void {
    runBackfill(runner, 0);
}

// --- Pushes to a base branch ---

/**
 * The listing of the open pull requests into one pushed branch. A push while
 * it runs moves it to the new tip; the pull requests its pass had already
 * scheduled were scheduled for the older tip, so once the pass reaches the
 * end it lists them again. Pushes faster than a pass completes keep the
 * listing cycling instead of restarting it, so no page is starved.
 */
interface BaseListing {
    /** The newest pushed tip; each batch schedules its pull requests for the tip current when it starts. */
    sha: string;
    /** Where the next batch resumes; null for the start. */
    from: PullRequestListCursor | null;
    /** Failed listings of the next batch so far. */
    attempts: number;
    /** A newer tip arrived after this pass scheduled pull requests for an older one. */
    again: boolean;
    timer: NodeJS.Timeout | null;
    running: boolean;
}
type BasePush = { repository: string; branch: string; key: string };
const baseListings = new Map<string, BaseListing>();

function armBaseListing(runner: PullRequestStatusReconcileRunner, push: BasePush, listing: BaseListing, delayMs: number): void {
    if (listing.timer) clearTimeout(listing.timer);
    listing.timer = setTimeout(() => runBaseListing(runner, push, listing), delayMs);
    listing.timer.unref?.();
}

/** The delay before the listing's next batch, or null once the listing is complete. */
function nextBaseBatch(listing: BaseListing, result: PullRequestStatusBasePushResult): number | null {
    listing.attempts = 0;
    if (result.next) {
        listing.from = result.next;
        return result.resumeAfterMs;
    }
    if (!listing.again) return null;
    listing.again = false;
    listing.from = null;
    return result.resumeAfterMs;
}

function runBaseListing(runner: PullRequestStatusReconcileRunner, push: BasePush, listing: BaseListing): void {
    listing.timer = null;
    listing.running = true;
    const { repository, branch } = push;
    void runner.refreshForBasePush({ repository, branch, sha: listing.sha, from: listing.from })
        .then(result => nextBaseBatch(listing, result), error => {
            // A failed listing settles nothing; retry the batch on the bounded schedule.
            const delay = runner.retryDelaysMs()[listing.attempts];
            logger.warn({ repository, branch, error: (error as Error).message, retrying: delay !== undefined },
                'Failed to list the open pull requests into a pushed branch for their status');
            if (delay !== undefined) listing.attempts++;
            return delay ?? null;
        })
        .then(delay => {
            listing.running = false;
            // The runs stopped meanwhile: the listing is no longer tracked.
            if (baseListings.get(push.key) !== listing) return;
            if (delay === null || !runner.enabled()) baseListings.delete(push.key);
            else armBaseListing(runner, push, listing, delay);
        });
}

/** A burst of pushes to one branch costs one listing, for its latest tip. */
export function schedulePullRequestStatusBaseListing(
    runner: PullRequestStatusReconcileRunner, push: { repository: string; branch: string; sha: string },
): void {
    const { repository, branch, sha } = push;
    const target = { repository, branch, key: `${repository.toLowerCase()}:${branch}` };
    const listing = baseListings.get(target.key);
    if (!listing) {
        const started: BaseListing = { sha, from: null, attempts: 0, again: false, timer: null, running: false };
        baseListings.set(target.key, started);
        armBaseListing(runner, target, started, runner.debounceMs);
        return;
    }
    if (listing.sha === sha) return;
    listing.sha = sha;
    // A batch from the start that has not run yet reads for the new tip anyway.
    if (listing.running || listing.from !== null) listing.again = true;
    // A new push does not wait for the retry of a failed listing.
    if (listing.attempts > 0) {
        listing.attempts = 0;
        if (!listing.running) armBaseListing(runner, target, listing, runner.debounceMs);
    }
}

/** Drops every pending batch; batches still running schedule no further one. */
export function stopPullRequestStatusReconcileRuns(): void {
    generation++;
    for (const timer of backfillTimers) clearTimeout(timer);
    backfillTimers.clear();
    for (const listing of baseListings.values()) if (listing.timer) clearTimeout(listing.timer);
    baseListings.clear();
}
