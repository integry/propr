import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
    closeConnection,
    type IndexingJobData,
    type RepositoryStatusTransition,
} from '@propr/core';
import {
    handleIndexingJobFailure,
    reconcileFailedIndexingJobs
} from '../src/indexingWorkerFailure.js';
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
    test('recovers a legacy run identity on a reconstructed BullMQ attempt', async () => {
        const firstJob: {
            id: string;
            timestamp: number;
            data: IndexingJobData;
            updateData: () => Promise<never>;
        } = {
            id: 'legacy-job-42',
            timestamp: Date.parse('2026-08-03T10:00:00.000Z'),
            data: {
                repository: 'acme/api',
                repoPath: '/tmp/acme-api',
                correlationId: 'legacy-enrichment-failure',
                baseBranch: 'main',
            },
            updateData: async () => { throw new Error('Redis update failed'); },
        };
        const secondJob: {
            id: string;
            timestamp: number;
            data: IndexingJobData;
            updateData: (data: IndexingJobData) => Promise<void>;
        } = {
            id: firstJob.id,
            timestamp: firstJob.timestamp,
            data: { ...firstJob.data },
            updateData: async (data) => { secondJob.data = data; },
        };
        let durableRun: { runId: string; transitionAt: string } | undefined;
        let identitiesCreated = 0;
        let indexingAttempts = 0;
        const processor = createIndexingJobProcessor({
            createLegacyIndexingRunIdForJob: () => {
                identitiesCreated++;
                return 'accepted-legacy-run';
            },
            updateRepositoryStatus: async (_repository, _status, _branch, options) => {
                durableRun ??= {
                    runId: options.runId!,
                    transitionAt: '2026-08-03T10:01:00.000Z',
                };
                return { ...durableRun, applied: true };
            },
            indexRepo: async () => { indexingAttempts++; return 'indexed'; },
            clearIndexingRuntimeStateBestEffort: clearRuntimeState,
        });

        await assert.rejects(processor(firstJob as never), /Redis update failed/);
        assert.equal(indexingAttempts, 0, 'indexing must not begin without durable queue data');
        assert.equal(firstJob.data.runId, 'accepted-legacy-run');
        assert.equal(secondJob.data.runId, undefined, 'Redis still has the legacy payload');
        assert.equal((await processor(secondJob as never)).status, 'completed');
        assert.equal(secondJob.data.runId, 'accepted-legacy-run');
        assert.equal(secondJob.data.durablyAccepted, true);
        assert.equal(identitiesCreated, 2);
        assert.equal(indexingAttempts, 1);
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

    test('does not execute a producer job before its durable acceptance exists', async () => {
        let indexingAttempts = 0;
        const processor = createIndexingJobProcessor({
            updateRepositoryStatus: async () => ({
                runId: 'rejected-api-run',
                transitionAt: '2026-08-03T10:00:00.000Z',
                applied: false,
            }),
            indexRepo: async () => { indexingAttempts++; return 'indexed'; },
            clearIndexingRuntimeStateBestEffort: clearRuntimeState,
        });
        const job = {
            id: 'modern-job',
            timestamp: Date.parse('2026-08-03T10:00:00.000Z'),
            data: {
                repository: 'acme/api',
                repoPath: '/tmp/acme-api',
                correlationId: 'rejected-api-request',
                baseBranch: 'main',
                runId: 'rejected-api-run',
                transitionAt: '2026-08-03T10:00:00.000Z',
            },
            updateData: async () => undefined,
        };

        await assert.rejects(processor(job as never), /waiting for durable producer acceptance/);
        assert.equal(indexingAttempts, 0);
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
            getRepositoryIndexingTerminalTransition: async () => ({
                runId: 'run-1',
                status: 'idle',
                transitionAt: '2026-08-03T00:00:00.000Z',
            }),
            publishIndexingStatus: async () => { publications++; },
        });
        assert.equal(publications, 0);
    });

    test('does not let an identity-less retained failure claim a newer active run', async () => {
        let statusWrites = 0;
        const job = {
            id: 'stale-failed-job',
            data: { repository: 'acme/api', baseBranch: 'main' } as IndexingJobData,
            attemptsMade: 3,
            opts: { attempts: 3 },
        };
        let failedRunId: string | undefined;
        assert.equal(await handleIndexingJobFailure(job, new Error('old failure'), {
            log: silentLogger,
            createLegacyIndexingRunIdForJob: () => 'stable-stale-job-run',
            updateRepositoryStatus: async (_repository, _status, _branch, options) => {
                statusWrites++;
                failedRunId = options.runId;
                return {
                    runId: options.runId!,
                    transitionAt: '2026-08-03T10:00:00.000Z',
                    applied: false,
                };
            },
            getRepositoryIndexingTerminalTransition: async () => undefined,
        }), false);
        assert.equal(statusWrites, 1);
        assert.equal(failedRunId, 'stable-stale-job-run');
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

    test('reconciles a failed job after its terminal write committed before a crash', async () => {
        let publications = 0;
        let clears = 0;
        let removals = 0;
        const job = {
            ...failedJob(3),
            failedReason: 'worker crashed after SQLite commit',
            remove: async () => { removals++; },
        };

        const reconciled = await reconcileFailedIndexingJobs({
            getJobs: async () => [job],
        }, {
            log: silentLogger,
            updateRepositoryStatus: async () => ({
                runId: 'run-1',
                transitionAt: '2026-08-03T00:00:00.000Z',
                applied: false,
            }),
            getRepositoryIndexingTerminalTransition: async () => ({
                runId: 'run-1',
                status: 'failed',
                transitionAt: '2026-08-03T00:00:00.000Z',
            }),
            publishIndexingStatus: async () => { publications++; },
            clearIndexingRuntimeStateBestEffort: async () => { clears++; },
        });

        assert.equal(reconciled, 1);
        assert.equal(publications, 1);
        assert.equal(clears, 1);
        assert.equal(removals, 1);
    });

    test('retains runtime evidence until a failed-job reconciliation persists the terminal', async () => {
        let writes = 0;
        let clears = 0;
        let publications = 0;
        let removals = 0;
        const job = {
            ...failedJob(3),
            failedReason: 'database was locked',
            remove: async () => { removals++; },
        };
        const overrides = {
            log: silentLogger,
            clearIndexingRuntimeStateBestEffort: async () => { clears++; },
            updateRepositoryStatus: async () => {
                writes++;
                if (writes === 1) throw new Error('SQLITE_BUSY');
                return {
                    runId: 'run-1',
                    transitionAt: '2026-08-03T00:00:00.000Z',
                    applied: true,
                };
            },
            publishIndexingStatus: async () => { publications++; },
        };

        await handleIndexingJobFailure(job, new Error(job.failedReason), overrides);
        assert.equal(clears, 0);

        assert.equal(await reconcileFailedIndexingJobs({
            getJobs: async () => [job],
        }, overrides), 1);
        assert.equal(writes, 2);
        assert.equal(publications, 1);
        assert.equal(clears, 1);
        assert.equal(removals, 1);
    });
});
