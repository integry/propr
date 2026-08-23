import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { validateAndExtractScoutContext } = await import('../src/jobs/reviewContextScoutValidation.js');

describe('review context scout validation', () => {
    test('extracts numbered raw excerpts from unchanged repository files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'propr-review-scout-'));
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'src', 'consumer.ts'), 'first\nsecond\nthird\nfourth\n');

        const context = await validateAndExtractScoutContext(root, ['src/changed.ts'], JSON.stringify({
            references: [{
                path: 'src/consumer.ts', startLine: 2, endLine: 3,
                relationship: 'direct consumer', reason: 'Calls the changed API',
            }],
        }));

        assert.match(context, /src\/consumer\.ts:2-3/);
        assert.match(context, /2: second/);
        assert.match(context, /3: third/);
    });

    test('rejects changed files, traversal, and invalid ranges', async () => {
        const root = await mkdtemp(join(tmpdir(), 'propr-review-scout-'));
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'src', 'changed.ts'), 'changed\n');
        await writeFile(join(root, 'src', 'safe.ts'), 'safe\n');

        const context = await validateAndExtractScoutContext(root, ['src/changed.ts'], JSON.stringify({
            references: [
                { path: 'src/changed.ts', startLine: 1, endLine: 1, relationship: 'changed', reason: 'duplicate' },
                { path: '../outside.ts', startLine: 1, endLine: 1, relationship: 'unsafe', reason: 'unsafe' },
                { path: 'src/safe.ts', startLine: 0, endLine: 1, relationship: 'invalid', reason: 'invalid' },
            ],
        }));

        assert.equal(context, '');
    });

    test('accepts JSON returned in a markdown fence', async () => {
        const root = await mkdtemp(join(tmpdir(), 'propr-review-scout-'));
        await writeFile(join(root, 'README.md'), 'repository guidance\n');
        const response = '```json\n{"references":[{"path":"README.md","startLine":1,"endLine":1,"relationship":"instruction","reason":"repository rule"}]}\n```';
        const context = await validateAndExtractScoutContext(root, [], response);
        assert.match(context, /repository guidance/);
    });
});
