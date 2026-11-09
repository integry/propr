import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { IssueJobData } from '@propr/core';
import { redisClient } from './issueJob/config.js';

/**
 * A no-change completion owed to an issue. It is retained before the done
 * marker is published, because once that marker is on the issue the
 * already-done check skips every later job, and only this record still says
 * that the trigger cleanup, the comment and the plan-status write are owed.
 */
export interface NoChangeCompletion {
    id: string;
    /** When the completing run retained it; recovery leaves fresh records to that run. */
    retainedAt?: number;
    triggeringLabel?: string;
    processingTag: string;
    doneTag: string;
    /** The labels the completing run observed; they decide the plan-status write. */
    labels: string[];
    /** Present until a settler claims the completion comment. */
    comment?: string;
}

export interface RetainedNoChangeCompletion { key: string; raw: string; record: NoChangeCompletion }
export type NoChangeCompletionStore = Pick<Redis, 'get' | 'set' | 'eval'>;
export type IssueCoordinates = Pick<IssueJobData, 'repoOwner' | 'repoName' | 'number'>;

export const NO_CHANGE_COMPLETION_KEY_PREFIX = 'issue:no-change-completion:';
/**
 * A record whose marker was never published, or whose issue never sees another
 * job or recovery pass, must not live forever. Recovery replays owed records
 * long before this; an issue untouched this long no longer drives a plan.
 */
export const NO_CHANGE_COMPLETION_TTL_SECONDS = 30 * 24 * 60 * 60;

const completionKey = (issue: IssueCoordinates) => `${NO_CHANGE_COMPLETION_KEY_PREFIX}${issue.repoOwner}/${issue.repoName}#${issue.number}`;

/** The issue a completion key belongs to; `null` for a key this module did not write. */
export function issueForCompletionKey(key: string): IssueCoordinates | null {
    const match = key.startsWith(NO_CHANGE_COMPLETION_KEY_PREFIX)
        ? /^([^/]+)\/(.+)#(\d+)$/u.exec(key.slice(NO_CHANGE_COMPLETION_KEY_PREFIX.length))
        : null;
    return match ? { repoOwner: match[1], repoName: match[2], number: Number(match[3]) } : null;
}

// Changes the record only while it is still the one this caller holds, so a
// settling run never clears a newer completion retained for the same issue,
// and of two settlers holding the same record only one wins each step.
export const REPLACE_NO_CHANGE_COMPLETION = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end
return 1`;

export async function retainNoChangeCompletion(
    issue: IssueCoordinates, completion: Omit<NoChangeCompletion, 'id'>, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion> {
    const record = { retainedAt: Date.now(), ...completion, id: randomUUID() };
    const raw = JSON.stringify(record);
    const key = completionKey(issue);
    await store.set(key, raw, 'EX', NO_CHANGE_COMPLETION_TTL_SECONDS);
    return { key, raw, record };
}

export async function readNoChangeCompletionAt(
    key: string, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion | null> {
    const raw = await store.get(key);
    return raw ? { key, raw, record: JSON.parse(raw) as NoChangeCompletion } : null;
}

export async function readNoChangeCompletion(
    issue: IssueCoordinates, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion | null> {
    return readNoChangeCompletionAt(completionKey(issue), store);
}

/** Replaces (or, with `null`, releases) the held record; `null` when another settler or a newer completion won. */
export async function replaceNoChangeCompletion(
    held: RetainedNoChangeCompletion, next: NoChangeCompletion | null, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion | null> {
    const raw = next ? JSON.stringify(next) : '';
    const replaced = await store.eval(REPLACE_NO_CHANGE_COMPLETION, 1, held.key, held.raw, raw, NO_CHANGE_COMPLETION_TTL_SECONDS);
    return Number(replaced) === 1 && next ? { key: held.key, raw, record: next } : null;
}
