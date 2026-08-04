import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import { closeConnection, shutdownQueue, type IndexingJobData } from '@propr/core';
import { createIndexingJobProcessor } from '../src/indexingJobProcessor.js';

after(async () => {
    await closeConnection();
    await shutdownQueue();
});

test('BullMQ preserves one indexing run across queue-data and indexing retries', {
    skip: !process.env.REDIS_HOST,
    timeout: 15_000,
}, async () => {
    const queueName = `indexing-retry-test-${process.pid}-${Date.now()}`;
    const connection = {
        host: process.env.REDIS_HOST!,
        port: Number(process.env.REDIS_PORT ?? 6379),
        maxRetriesPerRequest: null,
    };
    const queue = new Queue<IndexingJobData>(queueName, { connection });
    let indexAttempts = 0;
    let ownershipChecks = 0;
    let durableRun: { runId: string; transitionAt: string } | undefined;
    const observedRunIds: string[] = [];
    const processJob = createIndexingJobProcessor({
        indexRepo: async (_repoPath, options) => {
            indexAttempts++;
            assert.equal(options.deferFailureFinalization, true);
            observedRunIds.push(options.runId);
            if (indexAttempts === 1) throw new Error('transient index failure');
            return 'indexed';
        },
        updateRepositoryStatus: async (_repository, _status, _branch, run = {}) => {
            ownershipChecks++;
            durableRun ??= {
                runId: run.runId ?? 'retry-run',
                transitionAt: run.transitionAt ?? '2026-08-03T10:00:00.000Z',
            };
            return { ...durableRun, applied: true };
        },
        createLegacyIndexingRunIdForJob: () => 'retry-run',
        clearIndexingRuntimeStateBestEffort: async () => undefined,
    });
    let firstQueueDataWrite = true;
    const processor = async (job: Parameters<typeof processJob>[0]) => {
        if (firstQueueDataWrite) {
            firstQueueDataWrite = false;
            job.updateData = async () => { throw new Error('transient Redis data write failure'); };
        }
        return processJob(job);
    };
    const worker = new Worker<IndexingJobData>(queueName, processor, { connection });

    try {
        await worker.waitUntilReady();
        const completion = new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('retry job did not complete')), 10_000);
            worker.on('completed', (_job, result) => {
                clearTimeout(timeout);
                resolve(result);
            });
            worker.on('failed', (job, error) => {
                const attempts = Math.max(1, (job?.opts as JobsOptions | undefined)?.attempts ?? 1);
                if (job && job.attemptsMade < attempts) return;
                clearTimeout(timeout);
                reject(error);
            });
        });
        await queue.add('indexRepository', {
            repository: 'acme/api',
            repoPath: '/tmp/acme-api',
            correlationId: 'retry-correlation',
            baseBranch: 'main',
        }, {
            attempts: 3,
            backoff: { type: 'fixed', delay: 10 },
            removeOnComplete: false,
            removeOnFail: false,
        });
        const result = await completion as { status?: string };

        assert.equal(result.status, 'completed');
        assert.equal(indexAttempts, 2);
        assert.equal(ownershipChecks, 3);
        assert.deepEqual(observedRunIds, ['retry-run', 'retry-run']);
    } finally {
        await worker.close();
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
    }
});
