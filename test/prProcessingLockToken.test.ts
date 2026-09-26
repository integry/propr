import assert from 'node:assert/strict';
import test from 'node:test';
import { ensurePRProcessingLockToken } from '../src/jobs/prProcessingLock.js';

test('creates and persists a PR processing lock token when one is missing', async () => {
    const data: { prProcessingLockToken?: string } = {};
    let persistedToken: string | undefined;

    const token = await ensurePRProcessingLockToken(data, 'correlation-id', async () => {
        persistedToken = data.prProcessingLockToken;
    });

    assert.match(token, /^correlation-id:[0-9a-f-]{36}$/);
    assert.equal(data.prProcessingLockToken, token);
    assert.equal(persistedToken, token);
});

test('reuses a persisted PR processing lock token without writing again', async () => {
    const data = { prProcessingLockToken: 'existing-token' };
    let persistCalls = 0;

    const token = await ensurePRProcessingLockToken(data, 'correlation-id', async () => {
        persistCalls += 1;
    });

    assert.equal(token, 'existing-token');
    assert.equal(persistCalls, 0);
});
