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
    triggeringLabel?: string;
    processingTag: string;
    doneTag: string;
    /** The labels the completing run observed; they decide the plan-status write. */
    labels: string[];
    /** Present until the completion comment is posted. */
    comment?: string;
}

export interface RetainedNoChangeCompletion { key: string; raw: string; record: NoChangeCompletion }
export type NoChangeCompletionStore = Pick<Redis, 'get' | 'set' | 'eval'>;
type IssueCoordinates = Pick<IssueJobData, 'repoOwner' | 'repoName' | 'number'>;

const completionKey = (issue: IssueCoordinates) => `issue:no-change-completion:${issue.repoOwner}/${issue.repoName}#${issue.number}`;

// Changes the record only while it is still the one this caller holds, so a
// settling run never clears a newer completion retained for the same issue.
export const REPLACE_NO_CHANGE_COMPLETION = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end
return 1`;

export async function retainNoChangeCompletion(
    issue: IssueCoordinates, completion: Omit<NoChangeCompletion, 'id'>, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion> {
    const record = { ...completion, id: randomUUID() };
    const raw = JSON.stringify(record);
    const key = completionKey(issue);
    await store.set(key, raw);
    return { key, raw, record };
}

export async function readNoChangeCompletion(
    issue: IssueCoordinates, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion | null> {
    const key = completionKey(issue);
    const raw = await store.get(key);
    return raw ? { key, raw, record: JSON.parse(raw) as NoChangeCompletion } : null;
}

/** Replaces (or, with `null`, releases) the held record; `null` when a newer completion superseded it. */
export async function replaceNoChangeCompletion(
    held: RetainedNoChangeCompletion, next: NoChangeCompletion | null, store: NoChangeCompletionStore = redisClient,
): Promise<RetainedNoChangeCompletion | null> {
    const raw = next ? JSON.stringify(next) : '';
    const replaced = await store.eval(REPLACE_NO_CHANGE_COMPLETION, 1, held.key, held.raw, raw);
    return Number(replaced) === 1 && next ? { key: held.key, raw, record: next } : null;
}
