import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
    generateCorrelationId,
    getIssueQueue,
    logger,
    type CommentJobData,
    type UnprocessedComment,
} from '@propr/core';
import {
    completeManualUltrafixTakeover,
    listDeferredContinuationKeys,
    listUltrafixStateKeys,
    parseDeferredKey,
    parseUltrafixStateKey,
} from '../jobs/ultrafixOrchestrationService.js';
import {
    resumeDeferredContinuation,
    resumeTerminalUltrafixFinalization,
} from '../jobs/ultrafixLoopContinuation.js';
import { withUltrafixTransitionLease } from '../jobs/ultrafixTransitionLease.js';
import { scheduleUltrafixDeferredSweep } from './ultrafixDeferredSweep.js';
import { scheduleFreshUltrafixReservationSweep } from './ultrafixFreshReservationSweep.js';
import { scheduleManualUltrafixTakeoverSweep } from './ultrafixTakeoverSweep.js';
import { scheduleTerminalUltrafixFinalizationSweep } from './ultrafixTerminalSweep.js';

const createLogger = (): Logger => (
    logger.withCorrelation(generateCorrelationId()) as unknown as Logger
);

export async function scheduleUltrafixRecoverySweeps(redis: Redis): Promise<NodeJS.Timeout[]> {
    const deferred = await scheduleUltrafixDeferredSweep(redis, {
        listKeys: listDeferredContinuationKeys,
        parseKey: parseDeferredKey,
        resume: resumeDeferredContinuation,
        createLogger,
        warn: error => logger.warn({ error: error.message }, 'Ultrafix deferred continuation sweep failed'),
    });
    const fresh = await scheduleFreshUltrafixReservationSweep(redis, {
        getJob: async jobId => (await getIssueQueue()).getJob(jobId),
        withLease: withUltrafixTransitionLease,
        createLogger,
        generateCorrelationId,
        warn: error => logger.warn({ error: error.message }, 'Fresh Ultrafix reservation sweep failed'),
    });
    const takeover = await scheduleManualUltrafixTakeoverSweep(redis, {
        getJob: async jobId => (await getIssueQueue()).getJob(jobId),
        enqueueReplacement: async (jobId, identity, comment: UnprocessedComment, correlationId) => {
            const jobData: CommentJobData = {
                pullRequestNumber: identity.pr,
                comments: [comment],
                repoOwner: identity.owner,
                repoName: identity.repo,
                correlationId,
                commandMeta: comment.commandMeta,
                commandMode: comment.commandMode,
                requestedModels: comment.requestedModels,
                commandInstructions: comment.commandInstructions,
                commandCommentId: comment.id,
                commandSequence: comment.commandSequence,
                ultrafixMeta: comment.ultrafixMeta,
                llm: comment.llmOverride,
            };
            await (await getIssueQueue()).add('processPullRequestComment', jobData, {
                jobId,
                delay: 3_000,
                attempts: 3,
                backoff: { type: 'exponential', delay: 10_000 },
            });
        },
        complete: completeManualUltrafixTakeover,
        withLease: withUltrafixTransitionLease,
        createLogger,
        generateCorrelationId,
        warn: error => logger.warn({ error: error.message }, 'Manual Ultrafix takeover sweep failed'),
    });
    const terminal = await scheduleTerminalUltrafixFinalizationSweep(redis, {
        listKeys: listUltrafixStateKeys,
        parseKey: parseUltrafixStateKey,
        resume: resumeTerminalUltrafixFinalization,
        createLogger,
        warn: error => logger.warn({ error: error.message }, 'Ultrafix terminal finalization sweep failed'),
    });
    return [deferred, fresh, takeover, terminal];
}
