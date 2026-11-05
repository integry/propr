import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNameMatches, isNonBlockingCheck } from '../packages/core/src/webhook/nonBlockingChecks.js';
import { getNonBlockingChecksForRepository } from '../packages/core/src/daemon/configLoader.js';
import { currentHeadChecksHaveFailures, formatCurrentHeadCheckSummary } from '../src/jobs/reviewCheckSummary.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => { await closeConnection(); });

describe('non-blocking checks', () => {
    test('patterns match whole check names case-insensitively, with * for any text', () => {
        assert.equal(checkNameMatches('Validate unsigned darwin-x64 package', 'Validate unsigned * package'), true);
        assert.equal(checkNameMatches('Packaged Connect (linux-arm64)', 'packaged connect*'), true);
        assert.equal(checkNameMatches('Full Test Suite Native Electron (hosted)', 'Full Test Suite Native Electron (hosted)'), true);
        // Literal characters stay literal, and a pattern must cover the whole name.
        assert.equal(checkNameMatches('Validate unsigned darwin-x64 package', 'Validate unsigned'), false);
        assert.equal(checkNameMatches('Build & Lint Check', 'Build . Lint Check'), false);
        assert.equal(checkNameMatches('anything', '   '), false);
        assert.equal(isNonBlockingCheck(undefined, ['*']), false);
        assert.equal(isNonBlockingCheck('Run Full Test Suite', []), false);
    });

    test('a repository list is the union of its branch entries, and unreadable config blocks nothing', async () => {
        const repos = async () => [
            { name: 'integry/propr', enabled: true, nonBlockingChecks: ['Packaged Connect*', ' '] },
            { name: 'Integry/Propr', enabled: true, baseBranch: 'next', nonBlockingChecks: ['packaged connect*', 'Validate unsigned * package'] },
            { name: 'integry/other', enabled: true, nonBlockingChecks: ['Everything else'] },
        ];
        assert.deepEqual(await getNonBlockingChecksForRepository('integry', 'propr', repos as never),
            ['Packaged Connect*', 'Validate unsigned * package']);
        assert.deepEqual(await getNonBlockingChecksForRepository('integry', 'propr', async () => { throw new Error('db down'); }), []);
    });

    test('reviews see a non-blocking failure as neutral, labelled, and not as a failure of the change', () => {
        const runs = [
            { name: 'Run Full Test Suite', status: 'completed', conclusion: 'success' },
            { name: 'Validate unsigned darwin-x64 package', status: 'completed', conclusion: 'failure' },
        ];
        const isNonBlocking = (name: string | undefined) => isNonBlockingCheck(name, ['Validate unsigned * package']);
        assert.equal(currentHeadChecksHaveFailures(runs), true);
        assert.equal(currentHeadChecksHaveFailures(runs, isNonBlocking), false);
        const summary = formatCurrentHeadCheckSummary(runs, isNonBlocking);
        assert.match(summary, /0 failed/);
        assert.match(summary, /\[neutral\] Validate unsigned darwin-x64 package — status: completed; conclusion: failure \(non-blocking\)/);
    });
});
