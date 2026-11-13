import type { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import { pullRequestBodyKey } from './pullRequestBodyLock.js';
import { extractPullRequestStatusBlock } from './pullRequestStatusBlock.js';

/**
 * Provenance of the status block: the blocks ProPR itself wrote (or removed)
 * on each pull request. The `edited` webhook of a body change that stays inside
 * the block markers is ProPR's own only when the block it left behind is one
 * ProPR recorded writing. A person who deletes the block or types a status of
 * their own produces the same shape of event, and that edit must reconcile the
 * status instead of silently standing.
 *
 * Writes are recorded before the PATCH that makes them, so the webhook it
 * causes can never arrive ahead of its record. The record is kept in this
 * process and, when Redis is available, shared with the webhook processes.
 */
export type PullRequestStatusProvenanceRedis = Pick<Redis, 'get' | 'set'>;

/** Writes remembered per pull request; a burst of updates can have several webhooks in flight. */
const RECENT_WRITES = 8;
/** How long a recorded write stays recognisable; GitHub delivers webhooks within seconds, redeliveries within minutes. */
const RECORD_TTL_MS = 6 * 60 * 60 * 1000;
/** A removed block (closed or merged pull request, no room in the body) is recorded as the empty string. */
const REMOVED = '';

const localWrites = new Map<string, string[]>();

function redisKey(key: string): string {
    return `propr:pr-status:written:${key}`;
}

/** GitHub stores the body as sent; a body saved in the browser comes back with CRLF line ends. */
function normalize(block: string | null): string {
    return (block ?? REMOVED).replace(/\r\n/g, '\n');
}

function remember(recent: string[], entry: string): string[] {
    return [entry, ...recent.filter(known => known !== entry)].slice(0, RECENT_WRITES);
}

async function readShared(redis: PullRequestStatusProvenanceRedis | null, key: string): Promise<string[]> {
    if (!redis) return [];
    try {
        const raw = await redis.get(redisKey(key));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch (error) {
        logger.debug({ key, error: (error as Error).message }, 'Could not read the recorded pull request status writes');
        return [];
    }
}

/**
 * Records that ProPR is about to leave `block` (null: no block) in the body of
 * the pull request. Never throws: a lost record only costs one extra status
 * read when the webhook of this write arrives.
 */
export async function recordPullRequestStatusWrite(
    redis: PullRequestStatusProvenanceRedis | null, repository: string, prNumber: number, block: string | null,
): Promise<void> {
    const key = pullRequestBodyKey(repository, prNumber);
    const entry = normalize(block);
    localWrites.set(key, remember(localWrites.get(key) ?? [], entry));
    if (!redis) return;
    try {
        // Writers of one pull request are serialized by the body lock, so this read-modify-write does not race another record.
        const shared = remember(await readShared(redis, key), entry);
        await redis.set(redisKey(key), JSON.stringify(shared), 'PX', RECORD_TTL_MS);
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not record the pull request status write');
    }
}

/**
 * Whether the block in `body` (or its absence) is one ProPR recorded writing
 * on the pull request. The block text is compared exactly, update time
 * included: a person's replacement or deletion is never a recorded write.
 */
export async function isRecordedPullRequestStatusWrite(
    redis: PullRequestStatusProvenanceRedis | null, repository: string, prNumber: number, body: string | null | undefined,
): Promise<boolean> {
    const key = pullRequestBodyKey(repository, prNumber);
    const entry = normalize(extractPullRequestStatusBlock(body));
    if (localWrites.get(key)?.includes(entry)) return true;
    return (await readShared(redis, key)).includes(entry);
}

/** Test hook: forgets the writes recorded in this process. */
export function resetPullRequestStatusProvenanceForTests(): void {
    localWrites.clear();
}
