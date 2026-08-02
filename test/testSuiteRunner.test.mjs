import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    buildTestArguments,
    requiresModuleMocks,
    selectTestFiles,
} from '../scripts/run-test-suite.mjs';

describe('release test-suite runner', () => {
    test('selects supported test files deterministically and excludes live E2E', () => {
        assert.deepEqual(selectTestFiles([
            '/repo/test/z.test.ts',
            '/repo/test/e2e.test.ts',
            '/repo/test/e2e/webhook.test.ts',
            '/repo/test/a.test.mjs',
            '/repo/test/helper.ts',
            '/repo/test/b.test.js',
        ]), [
            '/repo/test/a.test.mjs',
            '/repo/test/b.test.js',
            '/repo/test/z.test.ts',
        ]);
    });

    test('enables the experimental flag only for module-mocking tests', () => {
        assert.equal(requiresModuleMocks("await mock.module('ioredis', {});"), true);
        assert.equal(requiresModuleMocks("test('plain test', () => {});"), false);
        assert.deepEqual(buildTestArguments('/repo/test/mock.test.ts', true), [
            '--experimental-test-module-mocks',
            '--test',
            '--test-force-exit',
            '/repo/test/mock.test.ts',
        ]);
        assert.deepEqual(buildTestArguments('/repo/test/plain.test.ts', false), [
            '--test',
            '--test-force-exit',
            '/repo/test/plain.test.ts',
        ]);
    });
});
