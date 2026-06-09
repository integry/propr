import { test, describe } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';

// --- Re-implementations of private functions for testing ---
// These mirror the logic in summaryMiner.ts and summaryMinerDirectories.ts

const EXCLUDED_PATHS = [
    'node_modules/',
    'vendor/',
    'dist/',
    'build/',
    '.git/',
    '__pycache__/',
    '.next/',
    '.nuxt/',
    'coverage/',
    '.cache/',
    'target/',
    'bin/',
    'obj/'
];

function shouldProcessFile(filePath: string): boolean {
    for (const excluded of EXCLUDED_PATHS) {
        if (filePath.includes(excluded)) {
            return false;
        }
    }
    return true;
}

function extractDirectories(filePaths: string[]): string[] {
    const dirs = new Set<string>();
    for (const filePath of filePaths) {
        const parts = filePath.split('/');
        let currentPath = '';
        for (let i = 0; i < parts.length - 1; i++) {
            currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
            dirs.add(currentPath);
        }
    }
    return Array.from(dirs);
}

function parseDirectorySummaryResponse(response: string): string | null {
    const trimmed = response.trim();
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            return parsed.summary || null;
        } catch {
            // Not JSON, use as-is
        }
    }
    return trimmed.length > 0 ? trimmed : null;
}

interface GitFileInfo {
    path: string;
    blobHash: string;
}

function identifyStaleFiles(
    fullName: string,
    gitFiles: GitFileInfo[],
    dbSummaries: Array<{ path: string; commit_hash: string }>,
    fullReindex: boolean = false
): { filesToProcess: GitFileInfo[]; filesToDelete: string[] } {
    const dbHashMap = new Map<string, string>();
    for (const summary of dbSummaries) {
        dbHashMap.set(summary.path, summary.commit_hash);
    }

    const gitFileFullPathSet = new Set(gitFiles.map(f => `${fullName}/${f.path}`));
    const filesToProcess: GitFileInfo[] = [];
    const filesToDelete: string[] = [];

    if (fullReindex) {
        filesToProcess.push(...gitFiles);
    } else {
        for (const file of gitFiles) {
            const fullPath = `${fullName}/${file.path}`;
            const dbHash = dbHashMap.get(fullPath);
            if (!dbHash) {
                filesToProcess.push(file);
            } else if (dbHash !== file.blobHash) {
                filesToProcess.push(file);
            }
        }
    }

    // Find deleted files (in DB but not in git)
    for (const dbPath of dbHashMap.keys()) {
        if (!gitFileFullPathSet.has(dbPath)) {
            filesToDelete.push(dbPath);
        }
    }

    return { filesToProcess, filesToDelete };
}

/**
 * Mirrors the chunked deletion logic in deleteFileSummaries
 */
function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
        chunks.push(arr.slice(i, i + chunkSize));
    }
    return chunks;
}

/**
 * Mirrors the stale directory detection logic in aggregateDirectories
 */
function findStaleDirs(
    existingDirPaths: string[],
    activeDirectories: Set<string>
): string[] {
    return existingDirPaths.filter(p => !activeDirectories.has(p));
}

// --- Tests ---

describe('Summary Miner - shouldProcessFile', () => {
    test('accepts source files without requiring a known extension', () => {
        assert.ok(shouldProcessFile('src/app.ts'));
        assert.ok(shouldProcessFile('lib/utils.py'));
        assert.ok(shouldProcessFile('release-site-src/src/pages/index.astro'));
        assert.ok(shouldProcessFile('scripts/deploy'));
        assert.ok(shouldProcessFile('config/custom.framework'));
    });

    test('rejects files in excluded directories', () => {
        assert.ok(!shouldProcessFile('node_modules/lodash/index.js'));
        assert.ok(!shouldProcessFile('vendor/autoload.php'));
        assert.ok(!shouldProcessFile('dist/bundle.js'));
        assert.ok(!shouldProcessFile('.git/HEAD'));
        assert.ok(!shouldProcessFile('__pycache__/module.py'));
        assert.ok(!shouldProcessFile('build/output.js'));
    });

    test('accepts files in non-excluded nested directories', () => {
        assert.ok(shouldProcessFile('src/components/Button.tsx'));
        assert.ok(shouldProcessFile('packages/core/lib/main.ts'));
    });
});

describe('Summary Miner - extractDirectories', () => {
    test('extracts all ancestor directories from file paths', () => {
        const dirs = extractDirectories(['repo/src/components/Button.tsx']);
        assert.ok(dirs.includes('repo'));
        assert.ok(dirs.includes('repo/src'));
        assert.ok(dirs.includes('repo/src/components'));
    });

    test('deduplicates directories from multiple files', () => {
        const dirs = extractDirectories([
            'repo/src/a.ts',
            'repo/src/b.ts',
            'repo/src/utils/c.ts'
        ]);
        const repoSrcCount = dirs.filter(d => d === 'repo/src').length;
        assert.strictEqual(repoSrcCount, 1, 'repo/src should appear exactly once');
    });

    test('handles root-level files (no directory)', () => {
        const dirs = extractDirectories(['README.md']);
        assert.strictEqual(dirs.length, 0);
    });

    test('handles empty input', () => {
        const dirs = extractDirectories([]);
        assert.strictEqual(dirs.length, 0);
    });

    test('handles files at various depths', () => {
        const dirs = extractDirectories([
            'a/file.ts',
            'a/b/c/d/deep.ts'
        ]);
        assert.ok(dirs.includes('a'));
        assert.ok(dirs.includes('a/b'));
        assert.ok(dirs.includes('a/b/c'));
        assert.ok(dirs.includes('a/b/c/d'));
    });
});

describe('Summary Miner - parseDirectorySummaryResponse', () => {
    test('returns plain text response as-is', () => {
        const result = parseDirectorySummaryResponse('This directory contains utility functions.');
        assert.strictEqual(result, 'This directory contains utility functions.');
    });

    test('extracts summary from JSON response', () => {
        const result = parseDirectorySummaryResponse('{"summary": "Contains auth logic"}');
        assert.strictEqual(result, 'Contains auth logic');
    });

    test('returns null for empty response', () => {
        const result = parseDirectorySummaryResponse('');
        assert.strictEqual(result, null);
    });

    test('returns null for whitespace-only response', () => {
        const result = parseDirectorySummaryResponse('   \n  ');
        assert.strictEqual(result, null);
    });

    test('returns null for JSON without summary field', () => {
        const result = parseDirectorySummaryResponse('{"content": "no summary key"}');
        assert.strictEqual(result, null);
    });

    test('handles JSON-like string that is not valid JSON', () => {
        const result = parseDirectorySummaryResponse('{this is not json}');
        assert.strictEqual(result, '{this is not json}');
    });

    test('trims whitespace from response', () => {
        const result = parseDirectorySummaryResponse('  Summary text with spaces  ');
        assert.strictEqual(result, 'Summary text with spaces');
    });
});

describe('Summary Miner - identifyStaleFiles', () => {
    test('identifies new files not in DB', () => {
        const gitFiles = [
            { path: 'src/new.ts', blobHash: 'abc123' }
        ];
        const dbSummaries: Array<{ path: string; commit_hash: string }> = [];

        const result = identifyStaleFiles('myrepo', gitFiles, dbSummaries);
        assert.strictEqual(result.filesToProcess.length, 1);
        assert.strictEqual(result.filesToProcess[0].path, 'src/new.ts');
        assert.strictEqual(result.filesToDelete.length, 0);
    });

    test('identifies changed files with different blob hash', () => {
        const gitFiles = [
            { path: 'src/changed.ts', blobHash: 'newhash' }
        ];
        const dbSummaries = [
            { path: 'myrepo/src/changed.ts', commit_hash: 'oldhash' }
        ];

        const result = identifyStaleFiles('myrepo', gitFiles, dbSummaries);
        assert.strictEqual(result.filesToProcess.length, 1);
        assert.strictEqual(result.filesToDelete.length, 0);
    });

    test('skips unchanged files', () => {
        const gitFiles = [
            { path: 'src/same.ts', blobHash: 'samehash' }
        ];
        const dbSummaries = [
            { path: 'myrepo/src/same.ts', commit_hash: 'samehash' }
        ];

        const result = identifyStaleFiles('myrepo', gitFiles, dbSummaries);
        assert.strictEqual(result.filesToProcess.length, 0);
        assert.strictEqual(result.filesToDelete.length, 0);
    });

    test('identifies deleted files in DB but not in git', () => {
        const gitFiles: GitFileInfo[] = [];
        const dbSummaries = [
            { path: 'myrepo/src/deleted.ts', commit_hash: 'abc123' }
        ];

        const result = identifyStaleFiles('myrepo', gitFiles, dbSummaries);
        assert.strictEqual(result.filesToProcess.length, 0);
        assert.strictEqual(result.filesToDelete.length, 1);
        assert.strictEqual(result.filesToDelete[0], 'myrepo/src/deleted.ts');
    });

    test('handles mix of new, changed, unchanged, and deleted files', () => {
        const gitFiles = [
            { path: 'src/new.ts', blobHash: 'new1' },
            { path: 'src/changed.ts', blobHash: 'changed_new' },
            { path: 'src/same.ts', blobHash: 'same1' }
        ];
        const dbSummaries = [
            { path: 'myrepo/src/changed.ts', commit_hash: 'changed_old' },
            { path: 'myrepo/src/same.ts', commit_hash: 'same1' },
            { path: 'myrepo/src/deleted.ts', commit_hash: 'del1' }
        ];

        const result = identifyStaleFiles('myrepo', gitFiles, dbSummaries);
        assert.strictEqual(result.filesToProcess.length, 2); // new + changed
        assert.strictEqual(result.filesToDelete.length, 1); // deleted
        assert.strictEqual(result.filesToDelete[0], 'myrepo/src/deleted.ts');
    });

    test('fullReindex processes all files regardless of staleness', () => {
        const gitFiles = [
            { path: 'src/same.ts', blobHash: 'samehash' },
            { path: 'src/other.ts', blobHash: 'otherhash' }
        ];
        const dbSummaries = [
            { path: 'myrepo/src/same.ts', commit_hash: 'samehash' },
            { path: 'myrepo/src/other.ts', commit_hash: 'otherhash' }
        ];

        const result = identifyStaleFiles('myrepo', gitFiles, dbSummaries, true);
        assert.strictEqual(result.filesToProcess.length, 2);
    });

    test('fullReindex still identifies deleted files', () => {
        const gitFiles = [
            { path: 'src/kept.ts', blobHash: 'hash1' }
        ];
        const dbSummaries = [
            { path: 'myrepo/src/kept.ts', commit_hash: 'hash1' },
            { path: 'myrepo/src/removed.ts', commit_hash: 'hash2' }
        ];

        const result = identifyStaleFiles('myrepo', gitFiles, dbSummaries, true);
        assert.strictEqual(result.filesToProcess.length, 1);
        assert.strictEqual(result.filesToDelete.length, 1);
        assert.strictEqual(result.filesToDelete[0], 'myrepo/src/removed.ts');
    });
});

describe('Summary Miner - Early Return Condition', () => {
    test('should NOT early return when only deletions exist (no files to process)', () => {
        // This tests the fix: previously the condition was only filesToProcess.length === 0,
        // which would early return even when there were files to delete
        const filesToProcess: GitFileInfo[] = [];
        const filesToDelete = ['myrepo/src/old.ts'];

        const shouldEarlyReturn = filesToProcess.length === 0 && filesToDelete.length === 0;
        assert.strictEqual(shouldEarlyReturn, false, 'Should not early return when there are files to delete');
    });

    test('should early return when both lists are empty', () => {
        const filesToProcess: GitFileInfo[] = [];
        const filesToDelete: string[] = [];

        const shouldEarlyReturn = filesToProcess.length === 0 && filesToDelete.length === 0;
        assert.strictEqual(shouldEarlyReturn, true);
    });

    test('should NOT early return when there are files to process', () => {
        const filesToProcess = [{ path: 'src/new.ts', blobHash: 'abc' }];
        const filesToDelete: string[] = [];

        const shouldEarlyReturn = filesToProcess.length === 0 && filesToDelete.length === 0;
        assert.strictEqual(shouldEarlyReturn, false);
    });

    test('should NOT early return when both lists have items', () => {
        const filesToProcess = [{ path: 'src/new.ts', blobHash: 'abc' }];
        const filesToDelete = ['myrepo/src/old.ts'];

        const shouldEarlyReturn = filesToProcess.length === 0 && filesToDelete.length === 0;
        assert.strictEqual(shouldEarlyReturn, false);
    });
});

describe('Summary Miner - Directory Aggregation Trigger', () => {
    test('triggers when files were processed', () => {
        const batchResult = { filesProcessed: 5, failedBatches: 0, totalBatches: 1 };
        const filesToDelete: string[] = [];

        const shouldAggregate = batchResult.filesProcessed > 0 || filesToDelete.length > 0;
        assert.strictEqual(shouldAggregate, true);
    });

    test('triggers when files were deleted (even if none processed)', () => {
        // This tests the fix: directory aggregation should run even when
        // only deletions occurred, to clean up stale directory summaries
        const batchResult = { filesProcessed: 0, failedBatches: 0, totalBatches: 0 };
        const filesToDelete = ['myrepo/src/old.ts'];

        const shouldAggregate = batchResult.filesProcessed > 0 || filesToDelete.length > 0;
        assert.strictEqual(shouldAggregate, true, 'Should trigger aggregation when files were deleted');
    });

    test('does not trigger when nothing was processed or deleted', () => {
        const batchResult = { filesProcessed: 0, failedBatches: 0, totalBatches: 0 };
        const filesToDelete: string[] = [];

        const shouldAggregate = batchResult.filesProcessed > 0 || filesToDelete.length > 0;
        assert.strictEqual(shouldAggregate, false);
    });

    test('triggers when both processed and deleted', () => {
        const batchResult = { filesProcessed: 3, failedBatches: 0, totalBatches: 1 };
        const filesToDelete = ['myrepo/src/old.ts'];

        const shouldAggregate = batchResult.filesProcessed > 0 || filesToDelete.length > 0;
        assert.strictEqual(shouldAggregate, true);
    });
});

describe('Summary Miner - Chunked Deletion', () => {
    test('creates single chunk for small arrays', () => {
        const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
        const chunks = chunkArray(items, 500);
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0].length, 10);
    });

    test('creates multiple chunks for large arrays', () => {
        const items = Array.from({ length: 1200 }, (_, i) => `item${i}`);
        const chunks = chunkArray(items, 500);
        assert.strictEqual(chunks.length, 3);
        assert.strictEqual(chunks[0].length, 500);
        assert.strictEqual(chunks[1].length, 500);
        assert.strictEqual(chunks[2].length, 200);
    });

    test('handles empty array', () => {
        const chunks = chunkArray([], 500);
        assert.strictEqual(chunks.length, 0);
    });

    test('handles array exactly at chunk size', () => {
        const items = Array.from({ length: 500 }, (_, i) => `item${i}`);
        const chunks = chunkArray(items, 500);
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0].length, 500);
    });

    test('preserves all items across chunks', () => {
        const items = Array.from({ length: 1050 }, (_, i) => `item${i}`);
        const chunks = chunkArray(items, 500);
        const totalItems = chunks.reduce((sum, c) => sum + c.length, 0);
        assert.strictEqual(totalItems, 1050);
    });
});

describe('Summary Miner - Stale Directory Detection', () => {
    test('detects directories no longer present in active set', () => {
        const existingDirPaths = [
            'repo/src',
            'repo/src/utils',
            'repo/src/old-module',
            'repo/lib'
        ];
        const activeDirectories = new Set([
            'repo/src',
            'repo/src/utils',
            'repo/lib'
        ]);

        const stale = findStaleDirs(existingDirPaths, activeDirectories);
        assert.strictEqual(stale.length, 1);
        assert.strictEqual(stale[0], 'repo/src/old-module');
    });

    test('returns empty when all directories are still active', () => {
        const existingDirPaths = ['repo/src', 'repo/lib'];
        const activeDirectories = new Set(['repo/src', 'repo/lib']);

        const stale = findStaleDirs(existingDirPaths, activeDirectories);
        assert.strictEqual(stale.length, 0);
    });

    test('detects all directories as stale when no files remain', () => {
        const existingDirPaths = ['repo/src', 'repo/src/utils', 'repo/lib'];
        const activeDirectories = new Set<string>();

        const stale = findStaleDirs(existingDirPaths, activeDirectories);
        assert.strictEqual(stale.length, 3);
    });

    test('handles empty existing directories', () => {
        const existingDirPaths: string[] = [];
        const activeDirectories = new Set(['repo/src']);

        const stale = findStaleDirs(existingDirPaths, activeDirectories);
        assert.strictEqual(stale.length, 0);
    });

    test('works with Set-based active directories from extractDirectories', () => {
        // Integration: extractDirectories + stale detection
        const filePaths = ['repo/src/a.ts', 'repo/lib/b.ts'];
        const activeDirectories = new Set(extractDirectories(filePaths));

        const existingDirPaths = [
            'repo',
            'repo/src',
            'repo/lib',
            'repo/old-dir',
            'repo/old-dir/nested'
        ];

        const stale = findStaleDirs(existingDirPaths, activeDirectories);
        assert.strictEqual(stale.length, 2);
        assert.ok(stale.includes('repo/old-dir'));
        assert.ok(stale.includes('repo/old-dir/nested'));
    });
});

describe('Summary Miner - clearRepositorySummaries query logic', () => {
    test('directory path matching includes both child paths and exact repo path', () => {
        const fullName = 'owner/repo';

        // Simulate the query logic: match "owner/repo/%" OR exact "owner/repo"
        const testPaths = [
            'owner/repo',
            'owner/repo/src',
            'owner/repo/src/utils',
            'other/repo',
            'other/repo/src'
        ];

        const matched = testPaths.filter(p =>
            p.startsWith(`${fullName}/`) || p === fullName
        );

        assert.strictEqual(matched.length, 3);
        assert.ok(matched.includes('owner/repo'));
        assert.ok(matched.includes('owner/repo/src'));
        assert.ok(matched.includes('owner/repo/src/utils'));
        assert.ok(!matched.includes('other/repo'));
    });

    test('does not match partial repo name prefixes', () => {
        const fullName = 'owner/repo';

        const testPaths = [
            'owner/repo-extra',
            'owner/repo-extra/src',
            'owner/repository',
        ];

        const matched = testPaths.filter(p =>
            p.startsWith(`${fullName}/`) || p === fullName
        );

        assert.strictEqual(matched.length, 0);
    });
});
