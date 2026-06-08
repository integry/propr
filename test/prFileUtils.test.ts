import { test, describe } from 'node:test';
import assert from 'node:assert';

process.env.GH_APP_ID ||= '1';
process.env.GH_INSTALLATION_ID ||= '1';
process.env.GH_PRIVATE_KEY ||= '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n';

const { formatPRDiff, formatPRDiffWithMetadata } = await import('../src/jobs/prFileUtils.js');

function prFile(overrides: Partial<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
}> = {}) {
    return {
        filename: 'src/example.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n-old\n+new',
        ...overrides,
    };
}

describe('formatPRDiff', () => {
    test('prioritizes smaller source changes before large lockfiles and binary files', () => {
        const diff = formatPRDiff([
            prFile({
                filename: 'package-lock.json',
                additions: 5000,
                deletions: 5000,
                patch: `${'x'.repeat(600)}\n`,
            }),
            prFile({
                filename: 'assets/logo.png',
                additions: 0,
                deletions: 0,
                patch: undefined,
            }),
            prFile({
                filename: 'src/small.ts',
                additions: 1,
                deletions: 1,
                patch: '@@ -1 +1 @@\n-a\n+b',
            }),
            prFile({
                filename: 'src/medium.ts',
                additions: 2,
                deletions: 1,
                patch: '@@ -1,2 +1,2 @@\n-a\n-b\n+c\n+d',
            }),
        ], 700);

        const smallIndex = diff.indexOf('## src/small.ts');
        const mediumIndex = diff.indexOf('## src/medium.ts');
        const lockIndex = diff.indexOf('## package-lock.json');
        const binaryIndex = diff.indexOf('## assets/logo.png');

        assert.ok(smallIndex > -1, 'small source file should be included');
        assert.ok(mediumIndex > -1, 'medium source file should be included');
        assert.ok(lockIndex === -1 || lockIndex > mediumIndex, 'lockfile should not come before source changes');
        assert.ok(binaryIndex === -1 || binaryIndex > mediumIndex, 'binary file should not come before source changes');
    });

    test('continues packing smaller files after an oversized file does not fit', () => {
        const diff = formatPRDiff([
            prFile({
                filename: 'package-lock.json',
                additions: 1000,
                deletions: 1000,
                patch: `${'x'.repeat(1000)}\n`,
            }),
            prFile({
                filename: 'src/a.ts',
                additions: 1,
                deletions: 0,
                patch: '@@ -1 +1 @@\n+a',
            }),
            prFile({
                filename: 'src/b.ts',
                additions: 1,
                deletions: 0,
                patch: '@@ -1 +1 @@\n+b',
            }),
        ], 260);

        assert.ok(diff.includes('## src/a.ts'), 'should include first small source file');
        assert.ok(diff.includes('## src/b.ts'), 'should include second small source file');
        assert.ok(!diff.includes('## package-lock.json'), 'should omit oversized lockfile');
        assert.ok(diff.includes('1 files omitted'), 'should report omitted files');
        assert.ok(diff.includes('**Files omitted from review diff:**'), 'should include omitted file list for the prompt');
        assert.ok(diff.includes('- package-lock.json'), 'should identify omitted lockfile');
        assert.ok(diff.includes('Large, binary, generated, and lockfile changes are deprioritized'));
    });

    test('returns omitted file metadata for the review result comment', () => {
        const result = formatPRDiffWithMetadata([
            prFile({
                filename: 'src/included.ts',
                additions: 1,
                deletions: 0,
                patch: '@@ -1 +1 @@\n+a',
            }),
            prFile({
                filename: 'package-lock.json',
                additions: 1000,
                deletions: 1000,
                patch: `${'x'.repeat(1000)}\n`,
            }),
        ], 220);

        assert.ok(result.diff.includes('## src/included.ts'), 'should include source diff');
        assert.deepStrictEqual(result.omittedFiles, ['package-lock.json']);
    });
});
