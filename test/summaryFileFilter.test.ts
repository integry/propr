import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    isProcessableFile,
    isTextLikeBuffer,
    shouldProcessFilePath
} from '../packages/core/src/services/relevance/summaryFileFilter.js';

describe('summaryFileFilter', () => {
    test('does not require known source extensions', () => {
        assert.ok(shouldProcessFilePath('release-site-src/src/pages/compare/coderabbit/index.astro'));
        assert.ok(shouldProcessFilePath('scripts/deploy'));
        assert.ok(shouldProcessFilePath('config/custom.framework'));
    });

    test('still rejects dependency and build output directories', () => {
        assert.ok(!shouldProcessFilePath('node_modules/pkg/index.js'));
        assert.ok(!shouldProcessFilePath('dist/client.js'));
        assert.ok(!shouldProcessFilePath('build/output.html'));
        assert.ok(!shouldProcessFilePath('.git/HEAD'));
    });

    test('detects binary buffers', () => {
        assert.ok(isTextLikeBuffer(Buffer.from('const value = 1;\n')));
        assert.ok(!isTextLikeBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])));
    });

    test('checks real files by path, size, and text content', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'summary-filter-'));
        try {
            await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
            await fs.writeFile(path.join(tempDir, 'src', 'page.astro'), '<h1>Hello</h1>\n');
            await fs.writeFile(path.join(tempDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

            assert.ok(isProcessableFile(tempDir, 'src/page.astro'));
            assert.ok(!isProcessableFile(tempDir, 'image.png'));
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});
