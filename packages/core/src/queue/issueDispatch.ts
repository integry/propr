/**
 * Issue dispatches: one durable SQLite row per issue (`issue_dispatches`)
 * decides whether a request to run the issue starts a new dispatch or is
 * served by the one already under way. BullMQ jobs are never replaced or
 * removed for this: each dispatch gets a fresh job ID
 * (`issue-<owner>-<repo>-<number>-<dispatchId>`), so no request can delete or
 * swallow another request's job.
 *
 * States, all transitions fenced on the row still holding the dispatch:
 *
 *   (none | completed | failed) ──enqueue──▶ queued
 *   queued ──disk-pressure refusal──▶ deferred ──next attempt picked up──▶ queued
 *   queued | deferred ──attempt enters its processor──▶ processing (sets started_at)
 *   processing ──failed attempt, retry follows──▶ queued
 *   any active ──job completed──▶ completed;  ──failed for good──▶ failed
 *
 * An attempt of a dispatch a newer one replaced on the row (a request took the
 * issue over, as when this job's producer added it late) is skipped at
 * admission and does not run its processor (`recordIssueJobAdmitted`).
 *
 * `started_at` is set when any attempt of the dispatch entered its processor
 * and is never cleared, so a report may say that nothing ran only when it is
 * null. `revision` grows with every transition: a request that found the
 * dispatch abandoned takes the issue over only while the row is still at the
 * revision that evidence was read at (`enqueueIssueDispatch`).
 *
 * `refusal_release` records a disk-pressure refusal of one of the issue's
 * executions that has not released the plan issue yet, because the issue's run
 * had not ended when it was refused (`issueDiskPressureRefusal.ts`).
 */
import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';

export const ISSUE_DISPATCHES_TABLE = 'issue_dispatches';

export type IssueDispatchState = 'queued' | 'deferred' | 'processing' | 'completed' | 'failed';
export type IssueDispatchRefusalRelease = 'pending' | 'released';
export const ACTIVE_ISSUE_DISPATCH_STATES: readonly IssueDispatchState[] = ['queued', 'deferred', 'processing'];
const isActive = (state: string) => (ACTIVE_ISSUE_DISPATCH_STATES as readonly string[]).includes(state);

export interface IssueDispatch {
    repository: string;
    issue_number: number;
    dispatch_id: string;
    job_id: string;
    state: IssueDispatchState;
    /** Grows with every transition of the dispatch; a new dispatch starts at 0. */
    revision: number;
    /**
     * `pending` while a disk-pressure refusal of one of the issue's executions waits for the issue's run to end
     * to release the plan issue; `released` once that release was claimed.
     */
    refusal_release: IssueDispatchRefusalRelease | null;
    /** Epoch ms at which an attempt of this dispatch first entered its processor; null while none has. */
    started_at: number | null;
    /** Epoch ms of the next attempt of a deferred dispatch. */
    retry_at: number | null;
    /** What admission measured at the latest disk-pressure refusal, in words. */
    details: string | null;
    error: string | null;
    created_at: number;
    updated_at: number;
}

/**
 * An active row whose job has finished, or is gone, is over: its outcome is
 * not recorded yet (the worker records it just after the job ends) or never
 * will be (the process died first). A finished job, and a missing job of a
 * `processing` or `deferred` row (which had its job), say so at once. A
 * missing job of a `queued` row may not have been added yet (the moment
 * between claiming the row and adding the job), so that row counts as over
 * only once it has not changed for this long, far above that moment.
 */
export const ISSUE_DISPATCH_ABANDON_AFTER_MS = 2 * 60_000;

const isOver = (dispatch: IssueDispatch, job: QueuedJobState, now: number) => job === 'finished'
    || (job === 'absent' && (dispatch.state !== 'queued' || now - Number(dispatch.updated_at) > ISSUE_DISPATCH_ABANDON_AFTER_MS));

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
interface Deps { database?: Knex; now?: () => number }

export interface IssueRef { owner: string; repo: string; number: number }

/** Owner and repository names are case-insensitive on GitHub; the row is keyed on the lower-case name. */
export const issueDispatchKey = ({ owner, repo, number }: IssueRef) => ({ repository: `${owner}/${repo}`.toLowerCase(), issue_number: number });

export const issueDispatchJobId = ({ owner, repo, number }: IssueRef, dispatchId: string): string => `issue-${owner}-${repo}-${number}-${dispatchId}`;

/** Hex, so the job ID gains no separator of its own. */
const newDispatchId = () => randomBytes(8).toString('hex');

const rows = (database: Knex) => database<IssueDispatch>(ISSUE_DISPATCHES_TABLE);

export async function findIssueDispatch(ref: IssueRef, { database = db }: Deps = {}): Promise<IssueDispatch | null> {
    return (await rows(database).where(issueDispatchKey(ref)).first()) ?? null;
}

export async function findIssueDispatchById(dispatchId: string, { database = db }: Deps = {}): Promise<IssueDispatch | null> {
    return (await rows(database).where({ dispatch_id: dispatchId }).first()) ?? null;
}

export type IssueDispatchClaim =
    | { status: 'claimed'; dispatch: IssueDispatch; previous: IssueDispatch | null }
    | { status: 'active'; dispatch: IssueDispatch };

/** The dispatch as a caller observed it: a takeover applies only while the row still holds it at that revision. */
export type ObservedIssueDispatch = Pick<IssueDispatch, 'dispatch_id' | 'revision'>;

const unchangedSince = (row: IssueDispatch, observed: ObservedIssueDispatch | undefined) =>
    observed !== undefined && row.dispatch_id === observed.dispatch_id && Number(row.revision) === Number(observed.revision);

/**
 * In one transaction: a new dispatch when the issue has none or its latest one
 * is terminal (or is `abandoned`, the dispatch the caller found abandoned,
 * still at the revision it was observed at), otherwise the active one. A new
 * dispatch is linked to the issue's newest plan issue, so its outcome may
 * change that plan issue only.
 */
export async function claimIssueDispatch(
    ref: IssueRef, { database = db, now = Date.now, abandoned }: Deps & { abandoned?: ObservedIssueDispatch } = {},
): Promise<IssueDispatchClaim> {
    const key = issueDispatchKey(ref);
    return database.transaction(async trx => {
        const previous = (await rows(trx).where(key).first()) ?? null;
        // A dispatch that moved since it was found abandoned (an attempt was admitted, say) is not taken over.
        if (previous && isActive(previous.state) && !unchangedSince(previous, abandoned)) return { status: 'active', dispatch: previous };
        const timestamp = now();
        const dispatchId = newDispatchId();
        const dispatch: IssueDispatch = {
            ...key, dispatch_id: dispatchId, job_id: issueDispatchJobId(ref, dispatchId), state: 'queued', revision: 0, refusal_release: null,
            started_at: null, retry_at: null, details: null, error: null, created_at: timestamp, updated_at: timestamp,
        };
        if (previous) await rows(trx).where(key).update(dispatch);
        else await rows(trx).insert(dispatch);
        const planIssue = await trx('plan_issues').whereRaw('lower(repository) = ?', [key.repository]).where({ issue_number: ref.number })
            .orderBy('created_at', 'desc').orderBy('id', 'desc').first('id');
        if (planIssue) await trx('plan_issues').where({ id: planIssue.id }).update({ issue_dispatch_id: dispatchId });
        return { status: 'claimed', dispatch, previous };
    });
}

interface DispatchQueue<D> {
    add(name: string, data: D, opts: { jobId: string } & Record<string, unknown>): Promise<unknown>;
    getJob?(jobId: string): Promise<{ getState(): Promise<string> } | undefined | null>;
}

type QueuedJobState = 'live' | 'finished' | 'absent' | null;

/** What the queue holds under the job ID; null when that could not be read. */
async function queuedJobState<D>(queue: DispatchQueue<D>, jobId: string): Promise<QueuedJobState> {
    if (typeof queue.getJob !== 'function') return null;
    try {
        const job = await queue.getJob(jobId);
        if (!job) return 'absent';
        const state = await job.getState();
        if (state === 'unknown') return 'absent';
        return state === 'completed' || state === 'failed' ? 'finished' : 'live';
    } catch {
        return null;
    }
}

/**
 * How many times a request reads the queue for the active dispatch's job: once,
 * and again each time that dispatch moved between the read and the takeover.
 */
const TAKEOVER_READS = 3;

export type IssueDispatchEnqueueOutcome =
    | { status: 'added'; dispatchId: string; jobId: string }
    | { status: 'already_queued'; dispatchId: string; jobId: string; state: IssueDispatchState };

/**
 * Enqueues the issue's job for a new dispatch, or reports the active dispatch
 * that serves the request instead. `data` must name the issue
 * (`repoOwner`, `repoName`, `number`); the job carries `issueDispatchId`.
 */
export async function enqueueIssueDispatch<D extends { repoOwner: string; repoName: string; number: number }>(
    queue: DispatchQueue<D & { issueDispatchId: string }>,
    { name, data, opts }: { name: string; data: D; opts: Record<string, unknown> },
    { database = db, now = Date.now, log = logger }: Deps & { log?: Log } = {},
): Promise<IssueDispatchEnqueueOutcome> {
    const ref = { owner: data.repoOwner, repo: data.repoName, number: data.number };
    let claim = await claimIssueDispatch(ref, { database, now });
    for (let reads = 0; claim.status === 'active' && reads < TAKEOVER_READS; reads++) {
        const observed = claim.dispatch;
        if (!isOver(observed, await queuedJobState(queue, observed.job_id), now())) break;
        log.info({ dispatchId: observed.dispatch_id, jobId: observed.job_id, state: observed.state, revision: observed.revision },
            'The active dispatch of this issue has no live job any more; starting a new dispatch unless it moved meanwhile');
        // Fenced on that dispatch at the revision the queue was read for: a request that replaced it meanwhile
        // serves this one, and a dispatch that moved meanwhile (as when its job was added late and admitted) is
        // read again from the queue before it may be taken over.
        claim = await claimIssueDispatch(ref, { database, now, abandoned: observed });
        if (claim.status === 'active' && claim.dispatch.dispatch_id === observed.dispatch_id && Number(claim.dispatch.revision) !== Number(observed.revision)) {
            log.info({ dispatchId: observed.dispatch_id, state: claim.dispatch.state, revision: claim.dispatch.revision },
                'The active dispatch of this issue moved since its job was found missing; reading the queue again');
        }
    }
    const { dispatch } = claim;
    if (claim.status === 'active') {
        log.info({ dispatchId: dispatch.dispatch_id, jobId: dispatch.job_id, state: dispatch.state },
            'This issue already has a queued or running dispatch; the request is served by it');
        return { status: 'already_queued', dispatchId: dispatch.dispatch_id, jobId: dispatch.job_id, state: dispatch.state };
    }
    try {
        await queue.add(name, { ...data, issueDispatchId: dispatch.dispatch_id }, { ...opts, jobId: dispatch.job_id });
    } catch (error) {
        // The add may have reached Redis before failing; only a job known to be absent ends the dispatch, and
        // only while no worker moved it (a job that was added, ran and was removed meanwhile is the worker's to settle).
        const job = await queuedJobState(queue, dispatch.job_id);
        if (job === 'live') return { status: 'added', dispatchId: dispatch.dispatch_id, jobId: dispatch.job_id };
        if (job === 'absent' || typeof queue.getJob !== 'function') {
            await settleIssueDispatch(dispatch.dispatch_id, 'failed', {
                database, now, error: `Could not be queued: ${(error as Error).message}`, atRevision: dispatch.revision,
            }).catch(() => undefined);
        }
        // The caller may report the job it could not confirm.
        throw Object.assign(error as Error, { jobId: dispatch.job_id, dispatchId: dispatch.dispatch_id });
    }
    log.info({ dispatchId: dispatch.dispatch_id, jobId: dispatch.job_id, previousState: claim.previous?.state ?? null }, 'Queued a new dispatch of this issue');
    return { status: 'added', dispatchId: dispatch.dispatch_id, jobId: dispatch.job_id };
}

/** The next revision of the row an update applies to. */
const nextRevision = (database: Knex) => database.raw('revision + 1') as unknown as number;

/**
 * Updates the dispatch's row while it holds this dispatch in one of `from`
 * (and, given `atRevision`, has not moved since that revision). True when it did.
 */
async function transition(
    dispatchId: string, from: readonly IssueDispatchState[], update: Partial<IssueDispatch>,
    { database = db, now = Date.now, atRevision }: Deps & { atRevision?: number },
): Promise<boolean> {
    const query = rows(database).where({ dispatch_id: dispatchId }).whereIn('state', from as IssueDispatchState[]);
    if (atRevision !== undefined) query.where({ revision: atRevision });
    const changed = await query.update({ ...update, revision: nextRevision(database), updated_at: now() });
    return Number(changed) > 0;
}

/** A deferred dispatch's job was picked up again: queued until admission decides. */
export const markIssueDispatchAttempt = (dispatchId: string, deps: Deps = {}) =>
    transition(dispatchId, ['deferred'], { state: 'queued' }, deps);

/** An attempt passed admission and enters its processor. */
export async function markIssueDispatchStarted(dispatchId: string, deps: Deps = {}): Promise<boolean> {
    const { database = db, now = Date.now } = deps;
    const timestamp = now();
    const changed = await rows(database).where({ dispatch_id: dispatchId }).whereIn('state', ['queued', 'deferred', 'processing'])
        .update({
            state: 'processing', started_at: database.raw('coalesce(started_at, ?)', [timestamp]) as unknown as number, retry_at: null,
            revision: nextRevision(database), updated_at: timestamp,
        });
    return Number(changed) > 0;
}

/**
 * An attempt passed admission: `started` when the row held the dispatch as
 * active (it is now processing), `ended` when the row still holds it but it
 * already ended, `superseded` when a newer dispatch replaced it on the row.
 */
export async function admitIssueDispatchAttempt(dispatchId: string, deps: Deps = {}): Promise<'started' | 'ended' | 'superseded'> {
    if (await markIssueDispatchStarted(dispatchId, deps)) return 'started';
    // Rows are only ever replaced, never deleted: no row under the dispatch means a newer one took the issue over.
    return (await findIssueDispatchById(dispatchId, deps)) ? 'ended' : 'superseded';
}

/** Admission refused an attempt for disk pressure; the same job waits until `retryAt`. */
export const markIssueDispatchDeferred = (dispatchId: string, { retryAt, details, ...deps }: Deps & { retryAt: number; details: string | null }) =>
    transition(dispatchId, ACTIVE_ISSUE_DISPATCH_STATES, { state: 'deferred', retry_at: retryAt, ...(details ? { details } : {}) }, deps);

/**
 * Settles an attempt's failure or the job's completion. A failure BullMQ
 * retries puts the dispatch back to queued; a final one, or completion, ends it.
 * `refused` records, with the end, that a disk-pressure refusal ended it
 * (`refusal_release` pending, see `recordIssueDispatchRefusal`).
 */
export function settleIssueDispatch(
    dispatchId: string, outcome: 'retrying' | 'failed' | 'completed',
    { error, details, refused, ...deps }: Deps & { error?: string; details?: string | null; refused?: boolean; atRevision?: number } = {},
): Promise<boolean> {
    const state: IssueDispatchState = outcome === 'retrying' ? 'queued' : outcome;
    return transition(dispatchId, ACTIVE_ISSUE_DISPATCH_STATES, {
        state, ...(error ? { error: error.slice(0, 2000) } : {}), ...(details ? { details } : {}), ...(outcome === 'retrying' ? {} : { retry_at: null }),
        ...(refused && outcome !== 'retrying' ? { refusal_release: 'pending' as const } : {}),
    }, deps);
}

/**
 * A disk-pressure refusal of one of the issue's executions, recorded as
 * pending on the dispatch the issue's row holds now (unless one was already
 * released for it), in one transaction with reading that row back. The plan
 * issue is released once the issue's run has ended, by whichever of this
 * refusal and the dispatcher's own settlement finds that it has: each records
 * its part (this refusal; the dispatch's end) before reading the other's, so
 * at least one of the two sees both. Null when the issue has no row.
 */
export async function recordIssueDispatchRefusal(ref: IssueRef, { database = db }: Deps = {}): Promise<IssueDispatch | null> {
    const key = issueDispatchKey(ref);
    return database.transaction(async trx => {
        await rows(trx).where(key).whereNull('refusal_release').update({ refusal_release: 'pending' });
        return (await rows(trx).where(key).first()) ?? null;
    });
}

/** Claims the release of the plan issue for the refusal pending on this dispatch: true for one caller only. */
export async function claimIssueDispatchRefusalRelease(dispatchId: string, { database = db }: Deps = {}): Promise<boolean> {
    const changed = await rows(database).where({ dispatch_id: dispatchId, refusal_release: 'pending' }).update({ refusal_release: 'released' });
    return Number(changed) > 0;
}
