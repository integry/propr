import { test, mock, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// Mock simple-git before importing the module under test
const mockGitInstance = {
    raw: mock.fn(async () => ''),
    status: mock.fn(async () => ({ conflicted: [] })),
};

await mock.module('simple-git', {
    namedExports: {
        simpleGit: mock.fn(() => mockGitInstance),
        SimpleGit: class {}
    }
});

// Mock logger
const mockLoggerInstance = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
};

await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: {
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
        withCorrelation: mock.fn(() => mockLoggerInstance),
    }
});

// Mock errorHandler
await mock.module('../packages/core/src/utils/errorHandler.js', {
    namedExports: {
        handleError: mock.fn(),
    }
});

// Import the module under test
const { mergeBaseIntoBranch } = await import('../packages/core/src/git/mergeOperations.js');
const { AI_COMMIT_AUTHOR } = await import('../packages/core/src/git/commitOperations.js');

function resetMocks() {
    mockGitInstance.raw.mock.resetCalls();
    mockGitInstance.status.mock.resetCalls();
}

describe('mergeBaseIntoBranch', () => {
    beforeEach(() => {
        resetMocks();
        // Default: all git commands succeed
        mockGitInstance.raw.mock.mockImplementation(async () => '');
    });

    test('returns clean outcome when merge succeeds without conflicts', async () => {
        const result = await mergeBaseIntoBranch('/tmp/worktree', 'main');

        assert.strictEqual(result.outcome, 'clean');
        assert.strictEqual(result.conflictedFiles, undefined);
        assert.strictEqual(result.error, undefined);

        // Should have called fetch and then merge
        const rawCalls = mockGitInstance.raw.mock.calls;
        assert.ok(rawCalls.length >= 3); // config name, config email, fetch, merge (fetch + merge at minimum)

        assert.ok(rawCalls.some((c: { arguments: string[][] }) =>
            c.arguments[0][0] === 'config' &&
            c.arguments[0][1] === 'user.name' &&
            c.arguments[0][2] === AI_COMMIT_AUTHOR.name
        ), 'Expected merge author name config');
        assert.ok(rawCalls.some((c: { arguments: string[][] }) =>
            c.arguments[0][0] === 'config' &&
            c.arguments[0][1] === 'user.email' &&
            c.arguments[0][2] === AI_COMMIT_AUTHOR.email
        ), 'Expected merge author email config');

        // Check fetch was called with the right args
        const fetchCall = rawCalls.find((c: { arguments: string[][] }) =>
            c.arguments[0][0] === 'fetch'
        );
        assert.ok(fetchCall, 'Expected a fetch call');
        assert.ok(fetchCall.arguments[0].includes('origin'));

        // Check merge was called
        const mergeCall = rawCalls.find((c: { arguments: string[][] }) =>
            c.arguments[0][0] === 'merge'
        );
        assert.ok(mergeCall, 'Expected a merge call');
        assert.ok(mergeCall.arguments[0].includes('origin/main'));
    });

    test('returns conflicts outcome when merge has conflicts', async () => {
        let callCount = 0;
        mockGitInstance.raw.mock.mockImplementation(async (args: string[]) => {
            if (args[0] === 'merge' && args[1]?.startsWith('origin/')) {
                throw new Error('CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.');
            }
            return '';
        });

        mockGitInstance.status.mock.mockImplementation(async () => ({
            conflicted: ['src/index.ts', 'src/utils.ts'],
        }));

        const result = await mergeBaseIntoBranch('/tmp/worktree', 'main');

        assert.strictEqual(result.outcome, 'conflicts');
        assert.deepStrictEqual(result.conflictedFiles, ['src/index.ts', 'src/utils.ts']);
    });

    test('returns failed outcome for non-conflict errors', async () => {
        mockGitInstance.raw.mock.mockImplementation(async (args: string[]) => {
            if (args[0] === 'merge') {
                throw new Error('fatal: not a git repository');
            }
            return '';
        });

        const result = await mergeBaseIntoBranch('/tmp/worktree', 'main');

        assert.strictEqual(result.outcome, 'failed');
        assert.ok(result.error?.includes('not a git repository'));
    });

    test('returns failed outcome when fetch fails', async () => {
        mockGitInstance.raw.mock.mockImplementation(async (args: string[]) => {
            if (args[0] === 'fetch') {
                throw new Error('fatal: could not read from remote repository');
            }
            return '';
        });

        const result = await mergeBaseIntoBranch('/tmp/worktree', 'main');

        assert.strictEqual(result.outcome, 'failed');
        assert.ok(result.error?.includes('could not read from remote'));
    });

    test('aborts merge on non-conflict failure', async () => {
        mockGitInstance.raw.mock.mockImplementation(async (args: string[]) => {
            if (args[0] === 'merge' && args[1]?.startsWith('origin/')) {
                throw new Error('fatal: some other merge error');
            }
            return '';
        });

        await mergeBaseIntoBranch('/tmp/worktree', 'main');

        // Should have called merge --abort
        const rawCalls = mockGitInstance.raw.mock.calls;
        const abortCall = rawCalls.find((c: { arguments: string[][] }) =>
            c.arguments[0][0] === 'merge' && c.arguments[0][1] === '--abort'
        );
        assert.ok(abortCall, 'Expected a merge --abort call for non-conflict failures');
    });
});
