import { describe, mock, test } from 'node:test';
import assert from 'node:assert';

type RepositoryRecord = { repository: string };

let issueMatches: RepositoryRecord[] = [];
let prMatches: RepositoryRecord[] = [];

const detectRepositoryRename = mock.fn();
const migrateRepositoryReferences = mock.fn();

function createPlanIssuesQuery() {
    let matchType: 'issue' | 'pr' | null = null;
    const query = {
        distinct() {
            return query;
        },
        where(column: string) {
            if (column === 'issue_number') matchType = 'issue';
            if (column === 'pr_number') matchType = 'pr';
            return query;
        },
        whereNot() {
            return Promise.resolve(matchType === 'issue' ? issueMatches : prMatches);
        }
    };
    return query;
}

const db = (table: string) => {
    assert.strictEqual(table, 'plan_issues');
    return createPlanIssuesQuery();
};

const log = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
};

await mock.module('../packages/core/src/db/connection.js', {
    namedExports: { db }
});

await mock.module('../packages/core/src/services/repositoryMigrationService.js', {
    namedExports: {
        detectRepositoryRename,
        migrateRepositoryReferences,
    }
});

await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(),
    }
});

await mock.module('../packages/core/src/daemon/configLoader.js', {
    namedExports: {
        getPrimaryProcessingLabels: mock.fn(() => ['AI']),
    }
});

const { checkAndMigrateRepositoryFromWebhook } = await import('../packages/core/src/webhook/planIssueTrackingHelpers.js');

function resetState() {
    issueMatches = [];
    prMatches = [];
    detectRepositoryRename.mock.resetCalls();
    migrateRepositoryReferences.mock.resetCalls();
    log.info.mock.resetCalls();
    log.warn.mock.resetCalls();
    log.error.mock.resetCalls();
    log.debug.mock.resetCalls();
}

describe('checkAndMigrateRepositoryFromWebhook', () => {
    test('does not migrate when another repository has the same issue number', async () => {
        resetState();
        issueMatches = [{ repository: 'integry/propr' }];
        detectRepositoryRename.mock.mockImplementation(async () => ({
            renamed: false,
            currentName: 'integry/propr',
        }));

        await checkAndMigrateRepositoryFromWebhook('integry/agent-tank', 1521, log);

        assert.strictEqual(detectRepositoryRename.mock.callCount(), 1);
        assert.strictEqual(migrateRepositoryReferences.mock.callCount(), 0);
    });

    test('migrates only when GitHub confirms the old repository redirects to the webhook repository', async () => {
        resetState();
        issueMatches = [{ repository: 'integry/propr-old' }];
        detectRepositoryRename.mock.mockImplementation(async () => ({
            renamed: true,
            currentName: 'integry/propr',
        }));
        migrateRepositoryReferences.mock.mockImplementation(async () => ({
            success: true,
            tablesUpdated: ['task_drafts'],
            rowsAffected: 1,
        }));

        await checkAndMigrateRepositoryFromWebhook('integry/propr', 1521, log);

        assert.strictEqual(detectRepositoryRename.mock.callCount(), 1);
        assert.strictEqual(migrateRepositoryReferences.mock.callCount(), 1);
        assert.deepStrictEqual(migrateRepositoryReferences.mock.calls[0].arguments, [
            'integry/propr-old',
            'integry/propr',
        ]);
    });
});
