import type { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { isCancelCiDuringFollowupEnabledForRepository } from '../daemon/configLoader.js';
import { getUltrafixStateRedis } from './checkRunHelpers.js';

/**
 * Pull requests that closed while their validation may still be running. The
 * webhook only records them; the worker's follow-up CI reconciliation cancels
 * the obsolete runs under the same per-repository policy as follow-up
 * implementations (see src/jobs/closedPullRequestCiCancellation.ts).
 */
export const CLOSED_PULL_REQUEST_CI_KEY = 'ci:closed-pull-request-cancellation';

export interface ClosedPullRequestCiRequest {
    repository: string;
    pullRequestNumber: number;
    headSha: string;
    headRef: string;
    /** `owner/name` of the head repository; a fork's runs still live in the base repository. */
    headRepository: string | null;
    merged: boolean;
    closedAt: string;
}

export function closedPullRequestCiField(repository: string, pullRequestNumber: number): string {
    return `${repository.toLowerCase()}#${pullRequestNumber}`;
}

interface ClosedPullRequestPayload {
    action: string;
    repository: { full_name: string; owner: { login: string }; name: string };
    pull_request: {
        number: number;
        merged?: boolean | null;
        closed_at?: string | null;
        head: { sha: string; ref: string; repo?: { full_name: string } | null };
    };
}

/** Records a closed pull request for CI cancellation when its repository opted in; never throws into webhook handling. */
export async function recordClosedPullRequestForCiCancellation(
    payload: ClosedPullRequestPayload,
    redis: Pick<Redis, 'hset'>,
    isEnabled: typeof isCancelCiDuringFollowupEnabledForRepository = isCancelCiDuringFollowupEnabledForRepository,
): Promise<boolean> {
    if (payload.action !== 'closed') return false;
    const { repository, pull_request: pullRequest } = payload;
    try {
        if (!await isEnabled(repository.owner.login, repository.name)) return false;
        const request: ClosedPullRequestCiRequest = {
            repository: repository.full_name,
            pullRequestNumber: pullRequest.number,
            headSha: pullRequest.head.sha,
            headRef: pullRequest.head.ref,
            headRepository: pullRequest.head.repo?.full_name ?? null,
            merged: pullRequest.merged === true,
            closedAt: pullRequest.closed_at ?? new Date().toISOString(),
        };
        await redis.hset(CLOSED_PULL_REQUEST_CI_KEY, closedPullRequestCiField(repository.full_name, pullRequest.number), JSON.stringify(request));
        return true;
    } catch (error) {
        logger.warn({ repository: repository.full_name, pullRequest: pullRequest.number, error: (error as Error).message },
            'Failed to record closed pull request for CI cancellation');
        return false;
    }
}

/** The Redis client shared by webhook state; the worker drains requests through the same instance. */
export function getClosedPullRequestCiRedis(): Redis {
    return getUltrafixStateRedis();
}
