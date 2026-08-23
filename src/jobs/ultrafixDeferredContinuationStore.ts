import type { Redis } from 'ioredis';
import type { UltrafixCommandMeta } from '@propr/core';
import type { UltrafixAction } from './ultrafixOrchestrationService.js';
import {
    getUltrafixDeferredKey,
    saveDeferredContinuationIfCurrent,
    ULTRAFIX_DEFERRED_KEY_PREFIX,
} from './ultrafixAutomaticWorkEpoch.js';

export interface UltrafixDeferredContinuation {
    owner: string;
    repo: string;
    pr: number;
    nextAction: UltrafixAction;
    savedAt: string;
    reason: string;
    ultrafixMeta?: UltrafixCommandMeta;
    workEpoch?: number;
}

export async function saveDeferredContinuation(
    redis: Redis,
    deferred: UltrafixDeferredContinuation,
): Promise<boolean> {
    const expectedEpoch = deferred.workEpoch ?? deferred.ultrafixMeta?.workEpoch ?? 0;
    return saveDeferredContinuationIfCurrent(
        redis,
        { owner: deferred.owner, repo: deferred.repo, pr: deferred.pr },
        expectedEpoch,
        JSON.stringify(deferred),
    );
}

export async function loadDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixDeferredContinuation | null> {
    const raw = await redis.get(getUltrafixDeferredKey(owner, repo, pr));
    return raw ? JSON.parse(raw) as UltrafixDeferredContinuation : null;
}

export async function claimDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixDeferredContinuation | null> {
    const raw = await redis.getdel(getUltrafixDeferredKey(owner, repo, pr));
    return raw ? JSON.parse(raw) as UltrafixDeferredContinuation : null;
}

export async function clearDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<void> {
    await redis.del(getUltrafixDeferredKey(owner, repo, pr));
}

export async function listDeferredContinuationKeys(redis: Redis): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const [nextCursor, batch] = await redis.scan(
            cursor, 'MATCH', `${ULTRAFIX_DEFERRED_KEY_PREFIX}:*`, 'COUNT', '100',
        );
        cursor = nextCursor;
        keys.push(...batch);
    } while (cursor !== '0');
    return keys;
}

export function parseDeferredKey(key: string): { owner: string; repo: string; pr: number } | null {
    const prefix = `${ULTRAFIX_DEFERRED_KEY_PREFIX}:`;
    if (!key.startsWith(prefix)) return null;
    const parts = key.slice(prefix.length).split(':');
    if (parts.length < 3) return null;
    const pr = parseInt(parts[parts.length - 1], 10);
    if (isNaN(pr)) return null;
    return { owner: parts[0], repo: parts.slice(1, -1).join(':'), pr };
}
