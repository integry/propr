import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { UnprocessedComment } from '@propr/core';
import { getPendingPrCommentsKey } from '../../packages/core/src/utils/constants.js';

const TAKEOVER_STAGE_PREFIX = 'pr-command-takeover';
const DELETE_STAGE_IF_SEQUENCE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

export interface ManualTakeoverStageIdentity {
    owner: string;
    repo: string;
    pr: number;
    eventType: string;
    commentId: number;
}

interface ManualTakeoverSweepDeps {
    getJob: (jobId: string) => Promise<unknown | null | undefined>;
    enqueueReplacement: (
        jobId: string,
        identity: ManualTakeoverStageIdentity,
        comment: UnprocessedComment,
        correlationId: string,
    ) => Promise<void>;
    complete: (
        redis: Redis,
        identity: { owner: string; repo: string; pr: number },
        commandSequence: number,
    ) => Promise<number | null>;
    /** True re-establishes this sequence's fence; false proves it is applied or superseded. */
    ensureFence: (
        redis: Redis,
        identity: { owner: string; repo: string; pr: number },
        commandSequence: number,
    ) => Promise<boolean>;
    withLease: <T>(
        redis: Redis,
        identity: { owner: string; repo: string; pr: number },
        correlationId: string,
        operation: (assertOwned: () => Promise<void>) => Promise<T>,
    ) => Promise<T>;
    createLogger: () => Logger;
    generateCorrelationId: () => string;
    warn: (error: Error) => void;
}

export function getManualTakeoverStageKey(identity: ManualTakeoverStageIdentity): string {
    return `${TAKEOVER_STAGE_PREFIX}:${identity.owner}:${identity.repo}:${identity.pr}:${identity.eventType}:${identity.commentId}`;
}

export function getManualTakeoverIntentKey(identity: ManualTakeoverStageIdentity): string {
    return `${getManualTakeoverStageKey(identity)}:intent`;
}

export function getManualTakeoverReplacementJobId(
    identity: ManualTakeoverStageIdentity,
    commandSequence: number,
): string {
    return `pr-comments-command-${identity.owner}-${identity.repo}-${identity.pr}-${identity.eventType}-${identity.commentId}-${commandSequence}`;
}

export function parseManualTakeoverStageKey(key: string): ManualTakeoverStageIdentity | null {
    const prefix = `${TAKEOVER_STAGE_PREFIX}:`;
    if (!key.startsWith(prefix)) return null;
    const [owner, repo, rawPr, eventType, rawCommentId, ...extra] = key.slice(prefix.length).split(':');
    const pr = Number(rawPr);
    const commentId = Number(rawCommentId);
    if (!owner || !repo || !eventType || extra.length > 0 || !Number.isInteger(pr) || !Number.isInteger(commentId)) {
        return null;
    }
    return { owner, repo, pr, eventType, commentId };
}

export async function listManualTakeoverStageKeys(redis: Redis): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const [nextCursor, batch] = await redis.scan(
            cursor, 'MATCH', `${TAKEOVER_STAGE_PREFIX}:*`, 'COUNT', '100',
        );
        cursor = nextCursor;
        keys.push(...batch);
    } while (cursor !== '0');
    return keys;
}

async function hasPendingReplacement(
    redis: Redis,
    identity: ManualTakeoverStageIdentity,
    commandSequence: number,
): Promise<boolean> {
    const pending = await redis.lrange(
        getPendingPrCommentsKey(identity.owner, identity.repo, identity.pr), 0, -1,
    );
    return pending.some(serialized => {
        try {
            return (JSON.parse(serialized) as { commandSequence?: number }).commandSequence === commandSequence;
        } catch {
            return false;
        }
    });
}

async function loadRecoveryIntent(
    redis: Redis,
    identity: ManualTakeoverStageIdentity,
    commandSequence: number,
): Promise<UnprocessedComment | null> {
    const serialized = await redis.get(getManualTakeoverIntentKey(identity));
    if (!serialized) return null;
    try {
        const comment = JSON.parse(serialized) as UnprocessedComment;
        return comment.commandSequence === commandSequence ? comment : null;
    } catch {
        return null;
    }
}

async function hasDurableReplacement(
    redis: Redis,
    identity: ManualTakeoverStageIdentity,
    commandSequence: number,
    getJob: ManualTakeoverSweepDeps['getJob'],
): Promise<boolean> {
    if (await getJob(getManualTakeoverReplacementJobId(identity, commandSequence))) return true;
    return hasPendingReplacement(redis, identity, commandSequence);
}

async function recoverStage(
    redis: Redis,
    stageKey: string,
    identity: ManualTakeoverStageIdentity,
    deps: ManualTakeoverSweepDeps,
): Promise<boolean> {
    const rawSequence = await redis.get(stageKey);
    if (rawSequence === null) return false;
    const commandSequence = Number(rawSequence);
    if (!Number.isInteger(commandSequence)) return false;
    const recoveryIntent = await loadRecoveryIntent(redis, identity, commandSequence);
    if (!recoveryIntent && !await hasDurableReplacement(redis, identity, commandSequence, deps.getJob)) {
        return false;
    }

    return deps.withLease(
        redis,
        { owner: identity.owner, repo: identity.repo, pr: identity.pr },
        deps.generateCorrelationId(),
        async assertOwned => {
            await assertOwned();
            if (await redis.get(stageKey) !== rawSequence) return false;
            const jobId = getManualTakeoverReplacementJobId(identity, commandSequence);
            if (!await deps.getJob(jobId)) {
                const intent = await loadRecoveryIntent(redis, identity, commandSequence) ?? recoveryIntent;
                if (intent) {
                    await deps.enqueueReplacement(jobId, identity, intent, deps.generateCorrelationId());
                    if (!await deps.getJob(jobId)) return false;
                } else if (!await hasPendingReplacement(redis, identity, commandSequence)) {
                    return false;
                }
            }
            await assertOwned();
            let completedGeneration = await deps.complete(
                redis,
                { owner: identity.owner, repo: identity.repo, pr: identity.pr },
                commandSequence,
            );
            if (completedGeneration === null) {
                await assertOwned();
                const retryable = await deps.ensureFence(
                    redis,
                    { owner: identity.owner, repo: identity.repo, pr: identity.pr },
                    commandSequence,
                );
                if (retryable) {
                    await assertOwned();
                    completedGeneration = await deps.complete(
                        redis,
                        { owner: identity.owner, repo: identity.repo, pr: identity.pr },
                        commandSequence,
                    );
                    if (completedGeneration === null) return false;
                }
                // A false result atomically proves that this sequence was already
                // applied or superseded by a newer applied/in-flight takeover.
            }
            await assertOwned();
            await redis.eval(
                DELETE_STAGE_IF_SEQUENCE_SCRIPT,
                2,
                stageKey,
                getManualTakeoverIntentKey(identity),
                rawSequence,
            );
            return true;
        },
    );
}

export async function sweepManualUltrafixTakeovers(
    redis: Redis,
    deps: ManualTakeoverSweepDeps,
): Promise<void> {
    let keys: string[];
    try {
        keys = await listManualTakeoverStageKeys(redis);
    } catch (error) {
        deps.warn(error as Error);
        return;
    }

    for (const key of keys) {
        try {
            const identity = parseManualTakeoverStageKey(key);
            if (!identity) continue;
            const recovered = await recoverStage(redis, key, identity, deps);
            if (recovered) {
                deps.createLogger().info(
                    { ...identity },
                    'Recovered a durably scheduled manual Ultrafix takeover',
                );
            }
        } catch (error) {
            deps.warn(error as Error);
        }
    }
}

export async function scheduleManualUltrafixTakeoverSweep(
    redis: Redis,
    deps: ManualTakeoverSweepDeps,
    intervalMs = 60_000,
): Promise<NodeJS.Timeout> {
    await sweepManualUltrafixTakeovers(redis, deps);
    const interval = setInterval(() => { void sweepManualUltrafixTakeovers(redis, deps); }, intervalMs);
    interval.unref();
    return interval;
}
