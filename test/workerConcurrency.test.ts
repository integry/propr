import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorkerConcurrency } from '../src/workerConcurrency.js';

const invalid = [undefined, null, '', ' ', 'invalid', '6workers', 0, -1, 1.5, '1.5', NaN, Infinity,
    'Infinity', Number.MAX_SAFE_INTEGER + 1, true, false, {}, [], [6]];

test('Hosted ignores absent, lower, higher and malformed persisted concurrency at every tier', () => {
    for (const ceiling of [2, 6, 12]) {
        for (const setting of [...invalid, 1, 50, '1', '50']) {
            for (const CONFIG_REPO of [undefined, '']) {
                assert.equal(resolveWorkerConcurrency(setting, { CONFIG_REPO, WORKER_CONCURRENCY: String(ceiling) }), ceiling);
            }
        }
    }
});

test('CONFIG_REPO preserves valid persisted overrides and falls back consistently', () => {
    for (const ceiling of [2, 6, 12]) {
        const env = { CONFIG_REPO: 'owner/config', WORKER_CONCURRENCY: String(ceiling) };
        for (const setting of [1, ceiling, 50, '1', String(ceiling), ' 50 ']) {
            assert.equal(resolveWorkerConcurrency(setting, env), Number(setting));
        }
        for (const setting of invalid) assert.equal(resolveWorkerConcurrency(setting, env), ceiling);
    }
});

test('invalid environment values use default 5; partial numbers and fractions are never truncated', () => {
    for (const value of invalid.filter(value => value === undefined || typeof value === 'string' || typeof value === 'number')) {
        const WORKER_CONCURRENCY = value === undefined ? undefined : String(value);
        for (const CONFIG_REPO of [undefined, 'owner/config']) {
            assert.equal(resolveWorkerConcurrency('bad', { CONFIG_REPO, WORKER_CONCURRENCY }), 5);
        }
        assert.equal(resolveWorkerConcurrency(2, { CONFIG_REPO: 'owner/config', WORKER_CONCURRENCY }), 2);
    }
    assert.equal(resolveWorkerConcurrency(undefined, { WORKER_CONCURRENCY: ' 6 ' }), 6);
});
