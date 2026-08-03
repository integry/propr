import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
    buildTestArguments,
    discoverTestFiles,
    discoverWorkspaceTestRoots,
    selectTestFiles,
    shouldFlushRedis,
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

    test('enables module mocking consistently for every test file', () => {
        assert.deepEqual(buildTestArguments('/repo/test/mock.test.ts'), [
            '--experimental-test-module-mocks',
            '--test',
            '/repo/test/mock.test.ts',
        ]);
    });

    test('requires an explicit flush opt-in before Redis isolation is destructive', () => {
        assert.equal(shouldFlushRedis(undefined), false);
        assert.equal(shouldFlushRedis('true'), false);
        assert.equal(shouldFlushRedis('off'), false);
        assert.equal(shouldFlushRedis(' FLUSH '), true);
    });

    test('discovers root and workspace tests while delegating native workspace runners', () => {
        const root = mkdtempSync(join(tmpdir(), 'propr-runner-discovery-'));
        const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
        try {
            mkdirSync(join(root, 'test'), { recursive: true });
            mkdirSync(join(root, 'packages', 'shared', 'test'), { recursive: true });
            mkdirSync(join(root, 'apps', 'service', 'src'), { recursive: true });
            mkdirSync(join(root, 'apps', 'narrow', 'src'), { recursive: true });
            mkdirSync(join(root, 'propr-ui', 'src'), { recursive: true });
            writeJson(join(root, 'package.json'), { workspaces: ['apps/*', 'packages/*', 'propr-ui'] });
            writeJson(join(root, 'packages', 'shared', 'package.json'), { name: '@propr/shared' });
            writeJson(join(root, 'apps', 'service', 'package.json'), { name: 'service' });
            writeJson(join(root, 'apps', 'narrow', 'package.json'), { name: 'narrow', scripts: { test: 'node --test one.test.ts' } });
            writeJson(join(root, 'propr-ui', 'package.json'), { name: 'propr-ui', scripts: { test: 'vitest run' } });
            writeFileSync(join(root, 'test', 'root.test.ts'), '');
            writeFileSync(join(root, 'packages', 'shared', 'test', 'shared.test.ts'), '');
            writeFileSync(join(root, 'apps', 'service', 'src', 'service.test.ts'), '');
            writeFileSync(join(root, 'apps', 'narrow', 'src', 'otherwise-omitted.test.ts'), '');
            writeFileSync(join(root, 'propr-ui', 'src', 'ui.test.ts'), '');

            assert.deepEqual(discoverWorkspaceTestRoots(root), [
                join(root, 'apps', 'narrow'),
                join(root, 'apps', 'service'),
                join(root, 'packages', 'shared'),
                join(root, 'test'),
            ]);
            assert.deepEqual(discoverTestFiles([], root), [
                join(root, 'apps', 'narrow', 'src', 'otherwise-omitted.test.ts'),
                join(root, 'apps', 'service', 'src', 'service.test.ts'),
                join(root, 'packages', 'shared', 'test', 'shared.test.ts'),
                join(root, 'test', 'root.test.ts'),
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
