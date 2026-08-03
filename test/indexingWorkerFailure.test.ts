import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection, type RepositoryStatusTransition } from '@propr/core';
import { handleIndexingJobFailure } from '../src/indexingWorkerFailure.js';

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
