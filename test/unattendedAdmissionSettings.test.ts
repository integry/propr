import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as actualCore from '@propr/core';

await mock.module('@propr/core', { namedExports: {
    ...actualCore,
    validateModelReasoningLevel: () => ({ valid: true, value: '' }),
    validatePrReviewModelValue: async () => ({ valid: true }),
} });
const { extractSettingSaves } = await import('../packages/api/routes/configSettings.js');
after(() => actualCore.closeConnection());

const { unattendedAdmissionSettingsResponse } = await import('../packages/api/routes/configRoutesSettings.js');

test('unattended_max_concurrent accepts integers from 0 to 100', async () => {
    for (const value of [0, 1, 100, '7']) {
        const result = await extractSettingSaves({ unattended_max_concurrent: value });
        assert.equal(result.error, undefined, `accepts ${value}`);
        assert.deepEqual(result.normalized, { unattended_max_concurrent: Number(value) });
        assert.deepEqual(result.saves, [{ name: 'unattended_max_concurrent' }]);
    }
});

test('unattended_max_concurrent rejects values outside the cap bounds', async () => {
    for (const value of [-1, 101, 1.5, 'two', true, null]) {
        const result = await extractSettingSaves({ ultrafix_rating_goal: 8, unattended_max_concurrent: value });
        assert.match(result.error ?? '', /unattended_max_concurrent must be an integer from 0 to 100/, `rejects ${String(value)}`);
        assert.deepEqual(result.saves, []);
    }
});

test('unattended_window saves a trimmed valid window and clears with an empty value', async () => {
    const valid = await extractSettingSaves({ unattended_window: ' 22:00-06:30@Europe/Riga ' });
    assert.equal(valid.error, undefined);
    assert.deepEqual(valid.normalized, { unattended_window: '22:00-06:30@Europe/Riga' });
    assert.deepEqual(valid.saves, [{ name: 'unattended_window' }]);

    for (const value of ['', '   ', null]) {
        const cleared = await extractSettingSaves({ unattended_window: value });
        assert.equal(cleared.error, undefined);
        assert.deepEqual(cleared.normalized, { unattended_window: '' });
    }
});

test('a malformed unattended_window is rejected before any save', async () => {
    for (const value of ['02:00-07:00', '25:00-07:00@Europe/Riga', '02:00-02:00@Europe/Riga', '02:00-07:00@Mars/Base', 'nightly', 42]) {
        const result = await extractSettingSaves({ unattended_max_concurrent: 2, unattended_window: value });
        assert.match(result.error ?? '', /unattended_window/, `rejects ${String(value)}`);
        assert.deepEqual(result.saves, []);
    }
});

test('settings response reports stored values and a malformed stored window', async () => {
    const store = (values: Record<string, unknown>) => ({
        getConfig: async <T,>(key: string, fallback: T) => (key in values ? values[key] : fallback) as T,
    }) as unknown as Pick<typeof actualCore, 'getConfig'>;

    assert.deepEqual(await unattendedAdmissionSettingsResponse(store({})), {
        unattended_max_concurrent: 1, unattended_window: '', unattended_window_error: null,
    });
    assert.deepEqual(await unattendedAdmissionSettingsResponse(store({ unattended_max_concurrent: 3, unattended_window: '02:00-07:00@Europe/Riga' })), {
        unattended_max_concurrent: 3, unattended_window: '02:00-07:00@Europe/Riga', unattended_window_error: null,
    });
    const malformed = await unattendedAdmissionSettingsResponse(store({ unattended_max_concurrent: 'lots', unattended_window: '2am-7am' }));
    assert.equal(malformed.unattended_max_concurrent, 1);
    assert.equal(malformed.unattended_window, '2am-7am');
    assert.match(malformed.unattended_window_error ?? '', /not a window/);
});
