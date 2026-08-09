import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { getPendingPrCommentsKey } from '../../packages/core/src/utils/constants.js';

const TAKEOVER_STAGE_PREFIX = 'pr-command-takeover';
const DELETE_STAGE_IF_SEQUENCE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('DEL', KEYS[1])
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
    complete: (
        redis: Redis,
        identity: { owner: string; repo: string; pr: number },
        commandSequence: number,
    ) => Promise<number | null>;
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
    if (!await hasDurableReplacement(redis, identity, commandSequence, deps.getJob)) return false;

    return deps.withLease(
        redis,
        { owner: identity.owner, repo: identity.repo, pr: identity.pr },
        deps.generateCorrelationId(),
        async assertOwned => {
            await assertOwned();
            if (await redis.get(stageKey) !== rawSequence) return false;
            if (!await hasDurableReplacement(redis, identity, commandSequence, deps.getJob)) return false;
            await deps.complete(
                redis,
                { owner: identity.owner, repo: identity.repo, pr: identity.pr },
                commandSequence,
            );
            await redis.eval(DELETE_STAGE_IF_SEQUENCE_SCRIPT, 1, stageKey, rawSequence);
            return true;
        },
    );
}

export async function sweepManualUltrafixTakeovers(
    redis: Redis,
    deps: ManualTakeoverSweepDeps,
): Promise<void> {
    try {
        for (const key of await listManualTakeoverStageKeys(redis)) {
            const identity = parseManualTakeoverStageKey(key);
            if (!identity) continue;
            const recovered = await recoverStage(redis, key, identity, deps);
            if (recovered) {
                deps.createLogger().info(
                    { ...identity },
                    'Recovered a durably scheduled manual Ultrafix takeover',
                );
            }
        }
    } catch (error) {
        deps.warn(error as Error);
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
