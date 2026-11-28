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
 * `started_at` is set when any attempt of the dispatch entered its processor
 * and is never cleared, so a report may say that nothing ran only when it is
 * null.
 */
import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';

export const ISSUE_DISPATCHES_TABLE = 'issue_dispatches';

export type IssueDispatchState = 'queued' | 'deferred' | 'processing' | 'completed' | 'failed';
export const ACTIVE_ISSUE_DISPATCH_STATES: readonly IssueDispatchState[] = ['queued', 'deferred', 'processing'];
const isActive = (state: string) => (ACTIVE_ISSUE_DISPATCH_STATES as readonly string[]).includes(state);

export interface IssueDispatch {
    repository: string;
    issue_number: number;
    dispatch_id: string;
    job_id: string;
    state: IssueDispatchState;
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

/**
 * In one transaction: a new dispatch when the issue has none or its latest one
 * is terminal (or is `abandoned`, the dispatch ID the caller found abandoned),
 * otherwise the active one. A new dispatch is linked to the issue's newest
 * plan issue, so its outcome may change that plan issue only.
 */
export async function claimIssueDispatch(
    ref: IssueRef, { database = db, now = Date.now, abandoned }: Deps & { abandoned?: string } = {},
): Promise<IssueDispatchClaim> {
    const key = issueDispatchKey(ref);
    return database.transaction(async trx => {
        const previous = (await rows(trx).where(key).first()) ?? null;
        if (previous && isActive(previous.state) && previous.dispatch_id !== abandoned) return { status: 'active', dispatch: previous };
        const timestamp = now();
        const dispatchId = newDispatchId();
        const dispatch: IssueDispatch = {
            ...key, dispatch_id: dispatchId, job_id: issueDispatchJobId(ref, dispatchId), state: 'queued',
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
    if (claim.status === 'active' && isOver(claim.dispatch, await queuedJobState(queue, claim.dispatch.job_id), now())) {
        log.info({ dispatchId: claim.dispatch.dispatch_id, jobId: claim.dispatch.job_id, state: claim.dispatch.state },
            'The active dispatch of this issue has no live job any more; starting a new dispatch');
        // Fenced on that dispatch: a request that advanced the row meanwhile wins, and this one is served by it.
        claim = await claimIssueDispatch(ref, { database, now, abandoned: claim.dispatch.dispatch_id });
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
        // The add may have reached Redis before failing; only a job known to be absent ends the dispatch.
        const job = await queuedJobState(queue, dispatch.job_id);
        if (job === 'live') return { status: 'added', dispatchId: dispatch.dispatch_id, jobId: dispatch.job_id };
        if (job === 'absent' || typeof queue.getJob !== 'function') {
            await settleIssueDispatch(dispatch.dispatch_id, 'failed', { database, now, error: `Could not be queued: ${(error as Error).message}` })
                .catch(() => undefined);
        }
        // The caller may report the job it could not confirm.
        throw Object.assign(error as Error, { jobId: dispatch.job_id, dispatchId: dispatch.dispatch_id });
    }
    log.info({ dispatchId: dispatch.dispatch_id, jobId: dispatch.job_id, previousState: claim.previous?.state ?? null }, 'Queued a new dispatch of this issue');
    return { status: 'added', dispatchId: dispatch.dispatch_id, jobId: dispatch.job_id };
}

/** Updates the dispatch's row while it holds this dispatch in one of `from`. True when it did. */
async function transition(
    dispatchId: string, from: readonly IssueDispatchState[], update: Partial<IssueDispatch>, { database = db, now = Date.now }: Deps,
): Promise<boolean> {
    const changed = await rows(database).where({ dispatch_id: dispatchId }).whereIn('state', from as IssueDispatchState[])
        .update({ ...update, updated_at: now() });
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
        .update({ state: 'processing', started_at: database.raw('coalesce(started_at, ?)', [timestamp]) as unknown as number, retry_at: null, updated_at: timestamp });
    return Number(changed) > 0;
}

/** Admission refused an attempt for disk pressure; the same job waits until `retryAt`. */
export const markIssueDispatchDeferred = (dispatchId: string, { retryAt, details, ...deps }: Deps & { retryAt: number; details: string | null }) =>
    transition(dispatchId, ACTIVE_ISSUE_DISPATCH_STATES, { state: 'deferred', retry_at: retryAt, ...(details ? { details } : {}) }, deps);

/**
 * Settles an attempt's failure or the job's completion. A failure BullMQ
 * retries puts the dispatch back to queued; a final one, or completion, ends it.
 */
export function settleIssueDispatch(
    dispatchId: string, outcome: 'retrying' | 'failed' | 'completed', { error, details, ...deps }: Deps & { error?: string; details?: string | null } = {},
): Promise<boolean> {
    const state: IssueDispatchState = outcome === 'retrying' ? 'queued' : outcome;
    return transition(dispatchId, ACTIVE_ISSUE_DISPATCH_STATES, {
        state, ...(error ? { error: error.slice(0, 2000) } : {}), ...(details ? { details } : {}), ...(outcome === 'retrying' ? {} : { retry_at: null }),
    }, deps);
}
