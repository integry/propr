import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { IssueJobData } from '@propr/core';
import { redisClient } from './issueJob/config.js';

/** A settler's exclusive, expiring right to post a completion comment. */
export interface CommentClaim { token: string; expiresAt: number }

/**
 * A no-change completion owed to an issue. It is retained before the done
 * marker is published, because once that marker is on the issue the
 * already-done check skips every later job, and only this record still says
 * that the trigger cleanup, the comment and the plan-status write are owed.
 * Each completing run retains its own record (a field of the issue's hash), so
 * concurrent completions of one issue, such as two models, never displace each other.
 */
export interface NoChangeCompletion {
    id: string;
    /** When the completing run retained it; recovery leaves fresh records to that run. */
    retainedAt?: number;
    /**
     * The request (job correlation ID) that produced this completion. Renewed
     * work admitted for the issue under another request supersedes it.
     */
    requestId?: string;
    triggeringLabel?: string;
    processingTag: string;
    doneTag: string;
    /** The labels the completing run observed; they decide the plan-status write. */
    labels: string[];
    /** The completion comment, kept until its delivery is established. */
    comment?: string;
    /** Present while a settler is posting the comment; an expired claim belongs to nobody. */
    commentClaim?: CommentClaim;
    /** A post may have reached GitHub, so the next claimant looks for its marker before posting again. */
    commentAttempted?: boolean;
}

export interface RetainedNoChangeCompletion { key: string; raw: string; record: NoChangeCompletion }
export type NoChangeCompletionStore = Pick<Redis, 'get' | 'set' | 'eval' | 'hgetall'>;
export type IssueCoordinates = Pick<IssueJobData, 'repoOwner' | 'repoName' | 'number'>;

export const NO_CHANGE_COMPLETION_KEY_PREFIX = 'issue:no-change-completions:';
export const NO_CHANGE_REQUEST_KEY_PREFIX = 'issue:no-change-request:';
/**
 * A record whose marker was never published, or whose issue never sees another
 * job or recovery pass, must not live forever. Recovery replays owed records
 * long before this; an issue untouched this long no longer drives a plan.
 */
export const NO_CHANGE_COMPLETION_TTL_SECONDS = 30 * 24 * 60 * 60;

const issuePath = (issue: IssueCoordinates) => `${issue.repoOwner}/${issue.repoName}#${issue.number}`;
const completionKey = (issue: IssueCoordinates) => `${NO_CHANGE_COMPLETION_KEY_PREFIX}${issuePath(issue)}`;
const requestKey = (issue: IssueCoordinates) => `${NO_CHANGE_REQUEST_KEY_PREFIX}${issuePath(issue)}`;

/** The issue a completion key belongs to; `null` for a key this module did not write. */
export function issueForCompletionKey(key: string): IssueCoordinates | null {
    const match = key.startsWith(NO_CHANGE_COMPLETION_KEY_PREFIX)
        ? /^([^/]+)\/(.+)#(\d+)$/u.exec(key.slice(NO_CHANGE_COMPLETION_KEY_PREFIX.length))
        : null;
    return match ? { repoOwner: match[1], repoName: match[2], number: Number(match[3]) } : null;
}

/** The request generation a job belongs to; every model and base of one request shares it. */
export function noChangeRequestId(issueRef: Pick<IssueJobData, 'correlationId'>): string | undefined {
    return issueRef.correlationId || undefined;
}

// Changes one completion (a hash field) only while it is still exactly what this
// caller holds (absent is ''), so a settler never overwrites another settler's
// step and of two settlers holding the same record only one wins each step.
export const REPLACE_NO_CHANGE_COMPLETION = `local current = redis.call('HGET', KEYS[1], ARGV[1]) or ''
if current ~= ARGV[2] then return 0 end
if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1]) else
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) redis.call('EXPIRE', KEYS[1], ARGV[4]) end
return 1`;

async function compareAndSet(
    { key, id, expected, next }: { key: string; id: string; expected: string; next: string }, store: NoChangeCompletionStore,
): Promise<boolean> {
    return Number(await store.eval(REPLACE_NO_CHANGE_COMPLETION, 1, key, id, expected, next, NO_CHANGE_COMPLETION_TTL_SECONDS)) === 1;
}

export async function retainNoChangeCompletion(
    issue: IssueCoordinates, completion: Omit<NoChangeCompletion, 'id'>, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion> {
    const record = { retainedAt: Date.now(), ...completion, id: randomUUID() };
    const raw = JSON.stringify(record);
    const key = completionKey(issue);
    // A fresh ID never collides, so this adds a record beside any other owed completion.
    if (!await compareAndSet({ key, id: record.id, expected: '', next: raw }, store)) throw new Error('Could not retain the no-change completion');
    return { key, raw, record };
}

/** Every completion retained under a completion key, oldest first. */
export async function readNoChangeCompletionsAt(
    key: string, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion[]> {
    const fields = await store.hgetall(key);
    return Object.values(fields ?? {})
        .map(raw => ({ key, raw, record: JSON.parse(raw) as NoChangeCompletion }))
        .sort((left, right) => (left.record.retainedAt ?? 0) - (right.record.retainedAt ?? 0));
}

export async function readNoChangeCompletions(
    issue: IssueCoordinates, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion[]> {
    return readNoChangeCompletionsAt(completionKey(issue), store);
}

/** Replaces (or, with `null`, releases) the held record; `null` when another settler won or it was superseded. */
export async function replaceNoChangeCompletion(
    held: RetainedNoChangeCompletion, next: NoChangeCompletion | null, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion | null> {
    const raw = next ? JSON.stringify(next) : '';
    const replaced = await compareAndSet({ key: held.key, id: held.record.id, expected: held.raw, next: raw }, store);
    return replaced && next ? { key: held.key, raw, record: next } : null;
}

/**
 * Whether the request that produced this completion is still the issue's
 * newest admitted request. A record or job without a request ID predates
 * this binding and cannot be told apart, so it is treated as current.
 */
export async function isCurrentNoChangeRequest(
    issue: IssueCoordinates, record: NoChangeCompletion, store: NoChangeCompletionStore = redisClient,
): Promise<boolean> {
    if (!record.requestId) return true;
    const current = await store.get(requestKey(issue));
    return !current || current === record.requestId;
}

// Drops one superseded completion only while the admitting request still owns
// the issue's request key, checked atomically with the record comparison, so an
// admission overtaken by a newer one never deletes that newer request's record.
// Returns -1 once the admitting request no longer owns the key.
export const DROP_SUPERSEDED_NO_CHANGE_COMPLETION = `if redis.call('GET', KEYS[2]) ~= ARGV[3] then return -1 end
local current = redis.call('HGET', KEYS[1], ARGV[1]) or ''
if current ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1`;

/**
 * Records that `requestId` is the issue's newest admitted request and drops
 * completions retained by older requests: their done marker and plan-status
 * write described work the user has since asked to be redone. Cleanup stops
 * as soon as a newer admission takes over the request key.
 * @returns the number of superseded completions dropped.
 */
export async function admitNoChangeRequest(
    issue: IssueCoordinates, requestId: string | undefined, store: NoChangeCompletionStore = redisClient,
): Promise<number> {
    if (!requestId) return 0;
    await store.set(requestKey(issue), requestId, 'EX', NO_CHANGE_COMPLETION_TTL_SECONDS);
    let dropped = 0;
    for (const held of await readNoChangeCompletions(issue, store)) {
        if (!held.record.requestId || held.record.requestId === requestId) continue;
        const outcome = Number(await store.eval(
            DROP_SUPERSEDED_NO_CHANGE_COMPLETION, 2, held.key, requestKey(issue), held.record.id, held.raw, requestId,
        ));
        // A newer admission owns the issue now; what remains is its to judge.
        if (outcome === -1) break;
        if (outcome === 1) dropped += 1;
    }
    return dropped;
}

/**
 * Whether the held completion is still retained and still answers the issue's
 * newest request. Settlers check it before every label mutation, so a
 * completion superseded mid-settlement stops instead of removing labels that
 * now belong to renewed work.
 */
export async function noChangeCompletionStillApplies(
    issue: IssueCoordinates, held: RetainedNoChangeCompletion, store: NoChangeCompletionStore = redisClient,
): Promise<boolean> {
    const retained = await readNoChangeCompletionsAt(held.key, store);
    const current = retained.find(entry => entry.record.id === held.record.id);
    return current !== undefined && isCurrentNoChangeRequest(issue, current.record, store);
}
