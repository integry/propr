import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RepoToMonitor } from '@propr/core';
import { normalizeRepoConfig, preserveRepoSettings } from '../packages/api/routes/configRepoValidation.js';

test('repository configuration validates context scope and preserves it for older clients', () => {
    const base = { id: 'id', name: 'owner/task', enabled: true };
    for (const contextRepositories of ['all', 'none', ['owner/shared']]) {
        const result = normalizeRepoConfig({ ...base, contextRepositories });
        assert.equal(result.ok, true);
        if (!result.ok) continue;
        assert.deepEqual(result.value.contextRepositories, contextRepositories);
        const update = normalizeRepoConfig(base);
        assert.equal(update.ok, true);
        if (update.ok) assert.deepEqual(preserveRepoSettings([result.value], [update.value], [base])[0].contextRepositories, contextRepositories);
    }
    for (const contextRepositories of [null, false, 'listed', ['../secret'], ['owner/..'], ['https://github.com/owner/repo']]) {
        assert.equal(normalizeRepoConfig({ ...base, contextRepositories }).ok, false);
    }
});

test('ID-less and unmatched-ID updates preserve restrictions by normalized repository identity', () => {
    for (const id of [undefined, 'new-id']) {
        for (const contextRepositories of ['none', ['owner/shared']] as RepoToMonitor['contextRepositories'][]) {
            const previous: RepoToMonitor[] = [{ id: 'stored', name: 'Owner/Task', enabled: true,
                contextRepositories }];
            const incoming = { id, name: 'owner/task', enabled: true };
            const normalized = normalizeRepoConfig(incoming);
            assert.ok(normalized.ok);
            assert.deepEqual(preserveRepoSettings(previous, [normalized.value], [incoming])[0].contextRepositories, contextRepositories);
        }
    }
});

test('omitted context retains the intersection when branch entries are collapsed or replaced', () => {
    for (const id of [undefined, 'main']) {
        for (const policies of [
            [undefined, 'all', ['owner/shared', 'owner/one'], ['OWNER/SHARED', 'owner/two']],
            [['owner/shared'], 'none'],
            [['owner/one'], ['owner/two']],
        ] as RepoToMonitor['contextRepositories'][][]) {
            const previous = policies.map((contextRepositories, index) => ({
                id: index === 0 ? 'main' : `branch-${index}`, name: index % 2 ? 'OWNER/TASK' : 'owner/task',
                enabled: true, baseBranch: `branch-${index}`, contextRepositories,
            }));
            const incoming = { id, name: 'owner/task', enabled: true };
            const normalized = normalizeRepoConfig(incoming);
            assert.ok(normalized.ok);
            const saved = preserveRepoSettings(previous, [normalized.value], [incoming]);
            assert.deepEqual(saved[0].contextRepositories, policies.includes('none') ? 'none' : policies.length === 4 ? ['owner/shared'] : []);
        }
    }
});

test('explicit context edits still apply and new repositories do not inherit another repository policy', () => {
    const previous: RepoToMonitor[] = [{ id: 'stored', name: 'owner/task', enabled: true, contextRepositories: 'none' }];
    for (const contextRepositories of ['all', 'none', ['owner/new']] as const) {
        const incoming = { name: 'owner/task', enabled: true, contextRepositories };
        const normalized = normalizeRepoConfig(incoming);
        assert.ok(normalized.ok);
        assert.deepEqual(preserveRepoSettings(previous, [normalized.value], [incoming])[0].contextRepositories, contextRepositories);
    }
    const incoming = { name: 'owner/new', enabled: true };
    const normalized = normalizeRepoConfig(incoming);
    assert.ok(normalized.ok);
    assert.equal(preserveRepoSettings(previous, [normalized.value], [incoming])[0].contextRepositories, undefined);
});
