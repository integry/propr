import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
    buildTestArguments,
    discoverTestFiles,
    discoverWorkspaceTestRoots,
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
            '/repo/test/component.test.tsx',
        ]), [
            '/repo/test/a.test.mjs',
            '/repo/test/b.test.js',
            '/repo/test/component.test.tsx',
            '/repo/test/z.test.ts',
        ]);
    });

    test('enables the experimental flag only for module-mocking tests', () => {
        assert.equal(requiresModuleMocks("await mock.module('ioredis', {});"), true);
        assert.equal(requiresModuleMocks("test('plain test', () => {});"), false);
        assert.deepEqual(buildTestArguments('/repo/test/mock.test.ts', true), [
            '--experimental-test-module-mocks',
            '--test',
            '/repo/test/mock.test.ts',
        ]);
        assert.deepEqual(buildTestArguments('/repo/test/plain.test.ts', false), [
            '--test',
            '/repo/test/plain.test.ts',
        ]);
    });

    test('discovers root and workspace tests while delegating native workspace runners', () => {
        const root = mkdtempSync(join(tmpdir(), 'propr-runner-discovery-'));
        const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
        try {
            mkdirSync(join(root, 'test'), { recursive: true });
            mkdirSync(join(root, 'packages', 'shared', 'test'), { recursive: true });
            mkdirSync(join(root, 'apps', 'service', 'src'), { recursive: true });
            mkdirSync(join(root, 'propr-ui', 'src'), { recursive: true });
            writeJson(join(root, 'package.json'), { workspaces: ['apps/*', 'packages/*', 'propr-ui'] });
            writeJson(join(root, 'packages', 'shared', 'package.json'), { name: '@propr/shared' });
            writeJson(join(root, 'apps', 'service', 'package.json'), { name: 'service' });
            writeJson(join(root, 'propr-ui', 'package.json'), { name: 'ui', scripts: { test: 'vitest run' } });
            writeFileSync(join(root, 'test', 'root.test.ts'), '');
            writeFileSync(join(root, 'packages', 'shared', 'test', 'shared.test.ts'), '');
            writeFileSync(join(root, 'apps', 'service', 'src', 'service.test.ts'), '');
            writeFileSync(join(root, 'propr-ui', 'src', 'ui.test.ts'), '');

            assert.deepEqual(discoverWorkspaceTestRoots(root), [
                join(root, 'apps', 'service'),
                join(root, 'packages', 'shared'),
                join(root, 'test'),
            ]);
            assert.deepEqual(discoverTestFiles([], root), [
                join(root, 'apps', 'service', 'src', 'service.test.ts'),
                join(root, 'packages', 'shared', 'test', 'shared.test.ts'),
                join(root, 'test', 'root.test.ts'),
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
