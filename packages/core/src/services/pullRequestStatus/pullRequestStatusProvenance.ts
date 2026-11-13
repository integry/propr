import type { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import { pullRequestBodyKey } from './pullRequestBodyLock.js';
import { extractPullRequestStatusBlock } from './pullRequestStatusBlock.js';

/**
 * Provenance of the status block: the block ProPR last intended to leave (or
 * removed) on each pull request. The `edited` webhook of a body change that
 * stays inside the block markers is ProPR's own only when the block it left
 * behind is that latest intended block. A person who deletes the block or
 * types a status of their own produces the same shape of event, and that edit
 * must reconcile the status instead of silently standing.
 *
 * Only the latest write counts. An earlier write, such as the removal when the
 * pull request was closed before it reopened, or a block since superseded,
 * proves nothing about the current edit: a person deleting the restored block
 * or putting an old one back leaves exactly what ProPR once wrote. The late
 * webhook of a superseded ProPR write is therefore reconciled as well; that
 * costs one status read, and no PATCH while the body holds the latest block.
 *
 * Writes are recorded before the PATCH that makes them, so the webhook it
 * causes can never arrive ahead of its record. The record is kept in this
 * process and, when Redis is available, shared with the webhook processes;
 * the newer of the two is the latest write.
 */
export type PullRequestStatusProvenanceRedis = Pick<Redis, 'get' | 'set'>;

/** How long a recorded write stays recognisable; GitHub delivers webhooks within seconds, redeliveries within minutes. */
const RECORD_TTL_MS = 6 * 60 * 60 * 1000;
/** A removed block (closed or merged pull request, no room in the body) is recorded as the empty string. */
const REMOVED = '';

interface RecordedWrite {
    block: string;
    /** Epoch milliseconds the write was recorded. */
    at: number;
}

const localWrites = new Map<string, RecordedWrite>();

function redisKey(key: string): string {
    return `propr:pr-status:written:${key}`;
}

/** GitHub stores the body as sent; a body saved in the browser comes back with CRLF line ends. */
function normalize(block: string | null): string {
    return (block ?? REMOVED).replace(/\r\n/g, '\n');
}

function isLive(write: RecordedWrite | undefined | null, now: number): write is RecordedWrite {
    return !!write && now - write.at < RECORD_TTL_MS;
}

function parseShared(raw: string | null): RecordedWrite | null {
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { block, at } = parsed as Partial<RecordedWrite>;
    return typeof block === 'string' && typeof at === 'number' ? { block, at } : null;
}

async function readShared(redis: PullRequestStatusProvenanceRedis | null, key: string): Promise<RecordedWrite | null> {
    if (!redis) return null;
    try {
        return parseShared(await redis.get(redisKey(key)));
    } catch (error) {
        logger.debug({ key, error: (error as Error).message }, 'Could not read the recorded pull request status write');
        return null;
    }
}

/**
 * Records that ProPR is about to leave `block` (null: no block) in the body of
 * the pull request, superseding every earlier write. Never throws: a lost
 * record only costs one extra status read when the webhook of this write arrives.
 */
export async function recordPullRequestStatusWrite(
    redis: PullRequestStatusProvenanceRedis | null, repository: string, prNumber: number, block: string | null,
): Promise<void> {
    const key = pullRequestBodyKey(repository, prNumber);
    const write: RecordedWrite = { block: normalize(block), at: Date.now() };
    localWrites.set(key, write);
    if (!redis) return;
    try {
        // Writers of one pull request are serialized by the body lock, so this write is never older than the one it replaces.
        await redis.set(redisKey(key), JSON.stringify(write), 'PX', RECORD_TTL_MS);
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not record the pull request status write');
    }
}

/**
 * Whether the block in `body` (or its absence) is the latest block ProPR
 * recorded writing on the pull request. The block text is compared exactly,
 * update time included: a person's replacement or deletion is never the
 * latest write, and neither is a restored earlier one.
 */
export async function isRecordedPullRequestStatusWrite(
    redis: PullRequestStatusProvenanceRedis | null, repository: string, prNumber: number, body: string | null | undefined,
): Promise<boolean> {
    const key = pullRequestBodyKey(repository, prNumber);
    const now = Date.now();
    const local = localWrites.get(key);
    if (local && !isLive(local, now)) localWrites.delete(key);
    const candidates = [local, await readShared(redis, key)].filter((write): write is RecordedWrite => isLive(write, now));
    if (candidates.length === 0) return false;
    const latest = candidates.reduce((newest, write) => (write.at > newest.at ? write : newest));
    return latest.block === normalize(extractPullRequestStatusBlock(body));
}

/** Test hook: forgets the writes recorded in this process. */
export function resetPullRequestStatusProvenanceForTests(): void {
    localWrites.clear();
}
