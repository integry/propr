import type { Redis } from 'ioredis';
import { logger, reconcileTaskIntents } from '@propr/core';

/** Reconciliation failures must not prevent startup or independent discovery. */
export async function reconcileTaskIntentsSafely(redis: Redis, repositories: string[]): Promise<void> {
    try {
        await reconcileTaskIntents(redis, repositories);
    } catch (error) {
        logger.warn({ error }, 'Failed to reconcile task intents; continuing discovery and retrying next poll');
    }
}
