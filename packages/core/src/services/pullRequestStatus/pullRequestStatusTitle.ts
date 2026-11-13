import type { Redis } from 'ioredis';
import { readStatusSlot, renderStatusSlot, stripStatusSlot, withStatusSlot, type TitleStatus } from '@propr/shared';
import logger from '../../utils/logger.js';
import type { PullRequestStatus } from './pullRequestStatus.js';
import { pullRequestBodyKey } from './pullRequestBodyLock.js';
import { isPullRequestStatusMaintained } from './pullRequestStatusSignal.js';

/**
 * The status slot in the title of a ProPR pull request (prTitleStatus): one
 * leading emoji for the persistent state, written by the status sync in the
 * same transition as the body block. Every rename adds a "changed the title"
 * entry to the timeline, so the title changes far less often than the block:
 *
 * - only the state, and the score beside ⚠️ and ✅, are shown; activity inside
 *   `working` never renames the pull request;
 * - ⚠️ and ✅ are written only after the same slot was computed again
 *   TITLE_SETTLE_MS later, so the moment between a run and the run it queues
 *   (an Ultrafix review and its fix, a failed check and its CI follow-up)
 *   costs no rename;
 * - a slot a person removed comes back only when the slot changes;
 * - no write is made when the title is already right.
 *
 * The slot ProPR last left (or found) in each title is recorded, like the body
 * block (pullRequestStatusProvenance), so the `edited` webhook of its own
 * rename is recognised and causes no further work. A rename is recorded as
 * pending before its PATCH and confirmed once GitHub accepted it: only a
 * confirmed slot missing from the title was removed by a person, and a
 * rejected rename is written again.
 */
export type PullRequestTitleRedis = Pick<Redis, 'get' | 'set'>;

/** How long a computed ⚠️ or ✅ must stand before the title shows it. */
const DEFAULT_TITLE_SETTLE_MS = 30_000;
let titleSettleMs = DEFAULT_TITLE_SETTLE_MS;

/** Test hook: shortens the hold before ⚠️ or ✅ is written; null restores it. */
export function setPullRequestTitleSettleMsForTests(ms: number | null): void {
    titleSettleMs = ms ?? DEFAULT_TITLE_SETTLE_MS;
}

/** Kept long: it decides whether a slot missing from a title was removed by a person. */
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A title ProPR left without a slot (closed, setting off) is recorded as the empty string. */
const NO_SLOT = '';

interface RecordedSlot {
    slot: string;
    at: number;
    /** Recorded before a rename GitHub has not yet accepted; such a slot may never have reached the title. */
    pending?: boolean;
}

const localSlots = new Map<string, RecordedSlot>();
const pendingSettles = new Map<string, { slot: string; since: number }>();

function redisKey(key: string): string {
    return `propr:pr-status:title:${key}`;
}

/** ⚠ without its variation selector is the same slot as ⚠️. */
function normalizeSlot(slot: string | null | undefined): string {
    return (slot ?? NO_SLOT).replace(/^⚠(?!️)/u, '⚠️');
}

async function readSharedSlot(redis: PullRequestTitleRedis | null, key: string): Promise<RecordedSlot | null> {
    if (!redis) return null;
    try {
        const raw = await redis.get(redisKey(key));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<RecordedSlot> | null;
        if (!parsed || typeof parsed.slot !== 'string' || typeof parsed.at !== 'number') return null;
        return { slot: parsed.slot, at: parsed.at, ...(parsed.pending === true ? { pending: true } : {}) };
    } catch (error) {
        logger.debug({ key, error: (error as Error).message }, 'Could not read the recorded pull request title slot');
        return null;
    }
}

/** The slot ProPR last recorded for the title; null when nothing is recorded. */
async function latestRecordedSlot(redis: PullRequestTitleRedis | null, repository: string, prNumber: number): Promise<RecordedSlot | null> {
    const key = pullRequestBodyKey(repository, prNumber);
    const now = Date.now();
    const candidates = [localSlots.get(key), await readSharedSlot(redis, key)]
        .filter((write): write is RecordedSlot => !!write && now - write.at < RECORD_TTL_MS);
    if (candidates.length === 0) return null;
    return candidates.reduce((newest, write) => (write.at > newest.at ? write : newest));
}

/**
 * Records the slot the title of the pull request has (null: none) as ProPR's
 * latest, confirmed: once GitHub accepted a rename, and when a slot is first
 * seen in the title. Never throws.
 */
export async function recordPullRequestTitleSlot(
    redis: PullRequestTitleRedis | null, repository: string, prNumber: number, slot: string | null,
): Promise<void> {
    await storeSlot(redis, { repository, prNumber }, { slot: normalizeSlot(slot), at: Date.now() });
}

/**
 * Records the slot a rename is about to give the title, before its PATCH, so
 * its webhook can never arrive ahead of the record. It stays pending, and is
 * never taken for a slot a person removed, until recordPullRequestTitleSlot
 * confirms it. Never throws.
 */
export async function recordPendingPullRequestTitleSlot(
    redis: PullRequestTitleRedis | null, repository: string, prNumber: number, slot: string | null,
): Promise<void> {
    await storeSlot(redis, { repository, prNumber }, { slot: normalizeSlot(slot), at: Date.now(), pending: true });
}

async function storeSlot(redis: PullRequestTitleRedis | null, target: { repository: string; prNumber: number }, write: RecordedSlot): Promise<void> {
    const { repository, prNumber } = target;
    const key = pullRequestBodyKey(repository, prNumber);
    localSlots.set(key, write);
    if (!redis) return;
    try {
        await redis.set(redisKey(key), JSON.stringify(write), 'PX', RECORD_TTL_MS);
    } catch (error) {
        logger.debug({ repository, prNumber, error: (error as Error).message }, 'Could not record the pull request title slot');
    }
}

/** Whether the slot of `title` (or its absence) is the latest slot ProPR recorded for the pull request. */
export async function isRecordedPullRequestTitleSlot(
    redis: PullRequestTitleRedis | null, repository: string, prNumber: number, title: string | null | undefined,
): Promise<boolean> {
    // A pending rename counts: its webhook can arrive before the PATCH returns.
    const recorded = await latestRecordedSlot(redis, repository, prNumber);
    return recorded !== null && recorded.slot === normalizeSlot(readStatusSlot(title));
}

/** The slot a status shows in the title: the state, and beside ⚠️ and ✅ the latest review score. */
export function titleStatusOf(status: PullRequestStatus): TitleStatus | null {
    if (status.state === 'none') return null;
    if (status.state === 'working') return { state: 'working' };
    return { state: status.state, score: status.detail.reviewScore };
}

export interface PullRequestTitleInput {
    repository: string;
    prNumber: number;
    title: string;
    /** Null once the pull request is closed or merged. */
    status: PullRequestStatus | null;
    /** ProPR created the pull request; only its titles are ever changed. */
    isProprPullRequest: boolean;
    /** The prTitleStatus setting; null when it could not be read, so the title is left as it is. */
    enabled: boolean | null;
    redis: PullRequestTitleRedis | null;
}

export interface PullRequestTitleDecision {
    /** The title to write; null when the title stays as it is. */
    title: string | null;
    /** A ⚠️ or ✅ waits to settle: run the update again after this many milliseconds. */
    settleInMs: number | null;
}

const UNCHANGED: PullRequestTitleDecision = { title: null, settleInMs: null };

function removal(title: string): PullRequestTitleDecision {
    return readStatusSlot(title) === null ? UNCHANGED : { title: stripStatusSlot(title), settleInMs: null };
}

/** Holds ⚠️ and ✅ back until the same slot is computed again TITLE_SETTLE_MS later. */
function settle(key: string, slot: string, now: number): number | null {
    const pending = pendingSettles.get(key);
    if (!pending || pending.slot !== slot) {
        pendingSettles.set(key, { slot, since: now });
        return titleSettleMs;
    }
    const left = titleSettleMs - (now - pending.since);
    if (left > 0) return left;
    pendingSettles.delete(key);
    return null;
}

/** Decides the title the status sync writes with the body block. */
export async function decidePullRequestTitle(input: PullRequestTitleInput): Promise<PullRequestTitleDecision> {
    const { repository, prNumber, title, status, redis } = input;
    const key = pullRequestBodyKey(repository, prNumber);
    if (!input.isProprPullRequest) return UNCHANGED;
    // Closed or merged: one final rename removes the slot, whatever the setting.
    if (!status) {
        pendingSettles.delete(key);
        return removal(title);
    }
    if (input.enabled === null) return UNCHANGED;
    const desired = input.enabled ? titleStatusOf(status) : null;
    if (!desired) {
        pendingSettles.delete(key);
        return removal(title);
    }
    const desiredSlot = renderStatusSlot(desired) as string;
    const currentSlot = readStatusSlot(title);
    if (normalizeSlot(currentSlot) === desiredSlot) {
        pendingSettles.delete(key);
        // A slot seen for the first time (a title created with it), or a rename not yet confirmed, is recorded
        // as confirmed: the title shows it, so a person removing it later is recognised.
        const recorded = await latestRecordedSlot(redis, repository, prNumber);
        if (recorded?.slot !== desiredSlot || recorded.pending) await recordPullRequestTitleSlot(redis, repository, prNumber, currentSlot);
        return UNCHANGED;
    }
    // A person removed the slot: it comes back on the next change of slot, not before. A pending
    // record proves nothing: GitHub may have rejected that rename, which is then written again.
    const recorded = currentSlot === null ? await latestRecordedSlot(redis, repository, prNumber) : null;
    if (recorded && !recorded.pending && recorded.slot === desiredSlot) {
        pendingSettles.delete(key);
        return UNCHANGED;
    }
    if (desired.state === 'working') {
        pendingSettles.delete(key);
    } else {
        const wait = settle(key, desiredSlot, Date.now());
        if (wait !== null) return { title: null, settleInMs: wait };
    }
    const next = withStatusSlot(title, desired);
    if (next === title) {
        logger.debug({ repository, prNumber }, 'The pull request title leaves no room for the status slot; it is left unchanged');
        return UNCHANGED;
    }
    return { title: next, settleInMs: null };
}

/**
 * The title the status sync writes with the block: reads the prTitleStatus
 * setting only for an open ProPR pull request, and leaves the title as it is
 * when the setting cannot be read. Pull requests read without a title are left alone.
 */
export async function decidePullRequestTitleForSync(input: {
    repository: string; prNumber: number; pull: { title?: string | null }; status: PullRequestStatus | null;
    isProprPullRequest: boolean; loadSetting: (repository: string) => Promise<boolean>; redis: PullRequestTitleRedis | null;
}): Promise<PullRequestTitleDecision> {
    const { repository, prNumber, pull, status } = input;
    if (typeof pull.title !== 'string' || !input.isProprPullRequest) return UNCHANGED;
    let enabled: boolean | null = null;
    if (status && status.state !== 'none') {
        try {
            enabled = await input.loadSetting(repository);
        } catch (error) {
            logger.warn({ repository, prNumber, error: (error as Error).message }, 'Could not read prTitleStatus; the pull request title is left unchanged');
        }
    }
    return await decidePullRequestTitle({ repository, prNumber, title: pull.title, status, isProprPullRequest: true, enabled, redis: input.redis });
}

/**
 * The title a new ProPR pull request is created with: `🔨 ` first when this
 * process maintains the status and the repository shows it in the title, so
 * creation costs no rename. Otherwise, or when the setting cannot be read,
 * the title is returned exactly as given.
 */
export async function initialPullRequestTitle(repository: string, title: string): Promise<string> {
    if (!isPullRequestStatusMaintained()) return title;
    try {
        // Loaded only here: the configuration store opens the database, which modules creating pull requests must not do on import.
        const { loadRepositoryPrTitleStatus } = await import('../../config/repositoryPrTitleStatusSetting.js');
        if (!await loadRepositoryPrTitleStatus(repository)) return title;
    } catch (error) {
        logger.debug({ repository, error: (error as Error).message }, 'Could not read prTitleStatus; the pull request is created without the title slot');
        return title;
    }
    return withStatusSlot(title, { state: 'working' });
}

/** Test hook: forgets the recorded slots and pending settles of this process. */
export function resetPullRequestTitleStateForTests(): void {
    localSlots.clear();
    pendingSettles.clear();
}
