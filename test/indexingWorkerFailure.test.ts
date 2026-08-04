import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
    closeConnection,
    type IndexingJobData,
    type RepositoryStatusTransition,
} from '@propr/core';
import { handleIndexingJobFailure } from '../src/indexingWorkerFailure.js';
import { createIndexingJobProcessor } from '../src/indexingJobProcessor.js';

after(async () => closeConnection());

const silentLogger = {
    error: () => undefined,
    warn: () => undefined,
};
const clearRuntimeState = async () => undefined;

function failedJob(attemptsMade: number, attempts = 3) {
    return {
        data: {
            repository: 'acme/api',
            baseBranch: 'main',
            runId: 'run-1',
        },
        attemptsMade,
        opts: { attempts },
    };
}

describe('indexing worker failure finalization', () => {
    test('retains a legacy run identity when BullMQ data enrichment fails', async () => {
        const job: { data: IndexingJobData; updateData: () => Promise<never> } = {
            data: {
                repository: 'acme/api',
                repoPath: '/tmp/acme-api',
                correlationId: 'legacy-enrichment-failure',
                baseBranch: 'main',
            },
            updateData: async () => { throw new Error('Redis update failed'); },
        };
        const processor = createIndexingJobProcessor({
            createIndexingRunIdentity: () => ({
                runId: 'accepted-legacy-run',
                transitionAt: '2026-08-03T10:00:00.000Z',
            }),
            updateRepositoryStatus: async () => ({
                runId: 'accepted-legacy-run',
                transitionAt: '2026-08-03T10:01:00.000Z',
                applied: true,
            }),
            indexRepo: async () => { throw new Error('indexing failed'); },
            clearIndexingRuntimeStateBestEffort: clearRuntimeState,
        });

        await assert.rejects(processor(job as never), /indexing failed/);
        assert.equal(job.data.runId, 'accepted-legacy-run');
        assert.equal(job.data.durablyAccepted, true);

        let finalizedRunId: string | undefined;
        await handleIndexingJobFailure({
            data: job.data,
            attemptsMade: 1,
            opts: { attempts: 1 },
        }, new Error('indexing failed'), {
            log: silentLogger,
            clearIndexingRuntimeStateBestEffort: clearRuntimeState,
            updateRepositoryStatus: async (_repository, _status, _branch, options) => {
                finalizedRunId = options.runId;
                return {
                    runId: options.runId!,
                    transitionAt: '2026-08-03T10:02:00.000Z',
                    applied: true,
                };
            },
            publishIndexingStatus: async () => undefined,
        });
        assert.equal(finalizedRunId, 'accepted-legacy-run');
    });

    test('does not terminally fail a run while BullMQ still has a retry', async () => {
        let statusWrites = 0;
        await handleIndexingJobFailure(failedJob(1), new Error('temporary'), {
            log: silentLogger,
            clearIndexingRuntimeStateBestEffort: clearRuntimeState,
            updateRepositoryStatus: async () => {
                statusWrites++;
                return {} as RepositoryStatusTransition;
            },
        });
        assert.equal(statusWrites, 0);
    });

    test('does not publish failure when cancellation already won the terminal CAS', async () => {
        let publications = 0;
        await handleIndexingJobFailure(failedJob(3), new Error('late failure'), {
            log: silentLogger,
            clearIndexingRuntimeStateBestEffort: clearRuntimeState,
            updateRepositoryStatus: async () => ({
                runId: 'run-1',
                transitionAt: '2026-08-03T00:00:00.000Z',
                applied: false,
            }),
            publishIndexingStatus: async () => { publications++; },
        });
        assert.equal(publications, 0);
    });

    test('publishes the durable failure after the final attempt', async () => {
        const publications: string[] = [];
        await handleIndexingJobFailure(failedJob(3), new Error('permanent'), {
            log: silentLogger,
            clearIndexingRuntimeStateBestEffort: clearRuntimeState,
            updateRepositoryStatus: async () => ({
                runId: 'run-1',
                transitionAt: '2026-08-03T00:00:00.000Z',
                applied: true,
            }),
            publishIndexingStatus: async (_repository, _branch, phase) => {
                publications.push(phase);
            },
        });
        assert.deepEqual(publications, ['failed']);
    });
});
