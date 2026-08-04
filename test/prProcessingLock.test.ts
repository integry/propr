import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import {
    acquirePRProcessingLock,
    DEFAULT_PR_PROCESSING_LOCK_TTL_SECONDS,
    PR_PROCESSING_LOCK_TTL_SECONDS,
} from '../src/jobs/prProcessingLock.js';

describe('PR processing lock lease', () => {
    test('uses a short renewable lease by default', async () => {
        assert.equal(DEFAULT_PR_PROCESSING_LOCK_TTL_SECONDS, 120);
        assert.ok(PR_PROCESSING_LOCK_TTL_SECONDS >= 60);

        const set = mock.fn(async () => 'OK');
        const acquired = await acquirePRProcessingLock({ set } as never, 'lock:key', 'owner-token');

        assert.equal(acquired, true);
        assert.deepEqual(set.mock.calls[0].arguments, [
            'lock:key',
            'owner-token',
            'EX',
            PR_PROCESSING_LOCK_TTL_SECONDS,
            'NX',
        ]);
    });
});
