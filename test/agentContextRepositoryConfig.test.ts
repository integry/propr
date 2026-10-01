import assert from 'node:assert/strict';
import { test } from 'node:test';
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
