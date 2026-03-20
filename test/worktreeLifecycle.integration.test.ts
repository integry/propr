import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { simpleGit, SimpleGit } from 'simple-git';

// ============================================================================
// Inline implementations of cleanup functions for testing
// These match the behavior in packages/core/src/git/worktreeOperations.ts
// without requiring GitHub env vars and other external dependencies
// ============================================================================

interface CleanupOptions {
    deleteBranch?: boolean;
    success?: boolean;
    retentionStrategy?: string;
    retentionHours?: number;
}

interface RetentionInfo {
    timestamp: string;
    issueProcessed: boolean;
    success: boolean;
    retentionHours: number;
    scheduledCleanup: string;
}

interface CleanupResult {
    cleaned: number;
    retained: number;
}

async function createRetentionMarker(worktreePath: string, retentionHours: number): Promise<void> {
    const retentionInfo: RetentionInfo = {
        timestamp: new Date().toISOString(),
        issueProcessed: true,
        success: false,
        retentionHours,
        scheduledCleanup: new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString()
    };
    await fs.writeJson(path.join(worktreePath, '.retention-info.json'), retentionInfo);
}

async function cleanupWorktree(
    localRepoPath: string,
    worktreePath: string,
    branchName: string,
    options: CleanupOptions = {}
): Promise<void> {
    const {
        deleteBranch = false,
        success = true,
        retentionStrategy = 'always_delete',
        retentionHours = 24
    } = options;

    // keep_on_failure: skip cleanup on failure
    if (!success && retentionStrategy === 'keep_on_failure') {
        await createRetentionMarker(worktreePath, retentionHours);
        return;
    }

    // keep_for_hours: create marker then proceed with cleanup
    if (!success && retentionStrategy === 'keep_for_hours') {
        await createRetentionMarker(worktreePath, retentionHours);
    }

    const git: SimpleGit = simpleGit(localRepoPath);

    try {
        await git.raw(['worktree', 'remove', worktreePath, '--force']);
    } catch {
        // Fallback to direct fs removal
        await fs.remove(worktreePath);
    }

    if (deleteBranch && branchName) {
        try {
            await git.deleteLocalBranch(branchName, true);
        } catch {
            // Ignore branch deletion errors
        }
    }
}

async function processWorktreeItem(itemPath: string, stats: fs.Stats): Promise<CleanupResult> {
    let cleaned = 0;
    let retained = 0;

    const retentionFile = path.join(itemPath, '.retention-info.json');

    if (await fs.pathExists(retentionFile)) {
        try {
            const retentionInfo = await fs.readJson(retentionFile) as RetentionInfo;
            const scheduledCleanup = new Date(retentionInfo.scheduledCleanup);
            const now = new Date();

            if (now >= scheduledCleanup) {
                await fs.remove(itemPath);
                cleaned++;
            } else {
                retained++;
            }
        } catch {
            // If we can't read retention info, retain the worktree
            retained++;
        }
    } else {
        // No retention marker - recursively check subdirectories
        const subResult = await processWorktreeDirectory(itemPath);
        cleaned += subResult.cleaned;
        retained += subResult.retained;
    }

    return { cleaned, retained };
}

async function processWorktreeDirectory(dirPath: string): Promise<CleanupResult> {
    let cleaned = 0;
    let retained = 0;

    const items = await fs.readdir(dirPath);

    for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stats = await fs.stat(itemPath);

        if (stats.isDirectory()) {
            const result = await processWorktreeItem(itemPath, stats);
            cleaned += result.cleaned;
            retained += result.retained;
        }
    }

    return { cleaned, retained };
}

async function cleanupExpiredWorktrees(worktreesBasePath: string): Promise<CleanupResult> {
    let cleaned = 0;
    let retained = 0;

    if (!await fs.pathExists(worktreesBasePath)) {
        return { cleaned, retained };
    }

    const result = await processWorktreeDirectory(worktreesBasePath);
    cleaned = result.cleaned;
    retained = result.retained;

    return { cleaned, retained };
}

interface WorktreeInfo {
    worktreePath: string;
    branchName: string;
    dirName: string;
}

interface IssueInfo {
    issueId: number;
    issueTitle: string;
    owner: string;
    repoName: string;
}

describe('Worktree Lifecycle Integration Tests', () => {
    let tempDir: string;
    let originalEnv: NodeJS.ProcessEnv;
    let testRepoPath: string;
    let worktreesBasePath: string;

    beforeEach(async () => {
        originalEnv = { ...process.env };

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-worktree-lifecycle-'));

        worktreesBasePath = path.join(tempDir, 'worktrees');
        testRepoPath = path.join(tempDir, 'test-repo');

        process.env.GIT_WORKTREES_BASE_PATH = worktreesBasePath;
        process.env.GIT_CLONES_BASE_PATH = path.join(tempDir, 'clones');

        await fs.ensureDir(worktreesBasePath);
        await fs.ensureDir(process.env.GIT_CLONES_BASE_PATH);

        // Create a test git repository
        await fs.ensureDir(testRepoPath);
        const git = simpleGit(testRepoPath);
        await git.init();
        await git.addConfig('user.email', 'test@example.com');
        await git.addConfig('user.name', 'Test User');

        // Create an initial commit so we have something to branch from
        const testFilePath = path.join(testRepoPath, 'README.md');
        await fs.writeFile(testFilePath, '# Test Repository\n');
        await git.add('.');
        await git.commit('Initial commit');
    });

    afterEach(async () => {
        process.env = originalEnv;

        if (tempDir) {
            await fs.remove(tempDir);
        }
    });

    function generateWorktreeInfo(issueInfo: IssueInfo, modelName?: string): WorktreeInfo {
        const { issueId, issueTitle, owner, repoName } = issueInfo;

        const sanitizedTitle = issueTitle
            .toLowerCase()
            .replace(/[^a-z0-9_\-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 25);

        const randomString = Math.random().toString(36).substring(2, 5);
        const now = new Date();
        const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

        const modelSuffix = modelName ? `-${modelName}` : '';
        const branchModelPrefix = modelName ? `${modelName}-` : '';
        const branchName = `${issueId}/${branchModelPrefix}${sanitizedTitle}-${shortTimestamp}-${randomString}`;
        const dirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
        const worktreePath = path.join(worktreesBasePath, owner, repoName, dirName);

        return { worktreePath, branchName, dirName };
    }

    async function createWorktreeWithGit(git: SimpleGit, worktreeInfo: WorktreeInfo, baseBranch: string): Promise<void> {
        await fs.ensureDir(path.dirname(worktreeInfo.worktreePath));
        await git.raw(['worktree', 'add', worktreeInfo.worktreePath, '-b', worktreeInfo.branchName, baseBranch]);
    }

    describe('Worktree Structure Creation', () => {
        test('creates worktree with proper directory structure', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 123,
                issueTitle: 'Test Issue',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Verify worktree directory exists
            const worktreeExists = await fs.pathExists(worktreeInfo.worktreePath);
            assert(worktreeExists, 'Worktree directory should exist');

            // Verify README.md from parent repo exists in worktree
            const readmeExists = await fs.pathExists(path.join(worktreeInfo.worktreePath, 'README.md'));
            assert(readmeExists, 'README.md should exist in worktree');
        });

        test('.git file exists in worktree (not a directory)', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 456,
                issueTitle: 'Git File Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            const gitFilePath = path.join(worktreeInfo.worktreePath, '.git');

            // Verify .git exists
            const gitFileExists = await fs.pathExists(gitFilePath);
            assert(gitFileExists, '.git file should exist in worktree');

            // Verify .git is a file, not a directory (key worktree characteristic)
            const stats = await fs.stat(gitFilePath);
            assert(stats.isFile(), '.git should be a file, not a directory (worktree indicator)');
        });

        test('.git file contains valid gitdir reference', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 789,
                issueTitle: 'Gitdir Reference Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            const gitFilePath = path.join(worktreeInfo.worktreePath, '.git');
            const gitFileContent = await fs.readFile(gitFilePath, 'utf8');

            // Verify .git file contains gitdir reference
            assert(gitFileContent.startsWith('gitdir:'), '.git file should start with "gitdir:"');

            // Extract and verify the gitdir path exists
            const match = gitFileContent.match(/gitdir:\s*(.+)/);
            assert(match, '.git file should contain gitdir path');

            const gitdirPath = match[1].trim();
            const gitdirExists = await fs.pathExists(gitdirPath);
            assert(gitdirExists, `gitdir path should exist: ${gitdirPath}`);
        });

        test('worktree creates unique directories for different issues', async () => {
            const git = simpleGit(testRepoPath);

            const issue1Info: IssueInfo = {
                issueId: 100,
                issueTitle: 'First Issue',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const issue2Info: IssueInfo = {
                issueId: 200,
                issueTitle: 'Second Issue',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktree1 = generateWorktreeInfo(issue1Info);
            const worktree2 = generateWorktreeInfo(issue2Info);

            await createWorktreeWithGit(git, worktree1, 'HEAD');
            await createWorktreeWithGit(git, worktree2, 'HEAD');

            // Verify both worktrees exist
            assert(await fs.pathExists(worktree1.worktreePath), 'First worktree should exist');
            assert(await fs.pathExists(worktree2.worktreePath), 'Second worktree should exist');

            // Verify they are different paths
            assert.notStrictEqual(
                worktree1.worktreePath,
                worktree2.worktreePath,
                'Worktrees for different issues should have different paths'
            );

            // Verify both have valid .git files
            const git1Stats = await fs.stat(path.join(worktree1.worktreePath, '.git'));
            const git2Stats = await fs.stat(path.join(worktree2.worktreePath, '.git'));
            assert(git1Stats.isFile(), 'First worktree .git should be a file');
            assert(git2Stats.isFile(), 'Second worktree .git should be a file');
        });

        test('worktree includes model suffix when model name provided', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 42,
                issueTitle: 'Model Suffix Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const opusWorktree = generateWorktreeInfo(issueInfo, 'opus');
            const sonnetWorktree = generateWorktreeInfo(issueInfo, 'sonnet');

            // Verify model suffix in directory names
            assert(opusWorktree.dirName.includes('-opus-'), 'Opus worktree dir should include -opus-');
            assert(sonnetWorktree.dirName.includes('-sonnet-'), 'Sonnet worktree dir should include -sonnet-');

            // Verify model prefix in branch names
            assert(opusWorktree.branchName.includes('opus-'), 'Opus branch should include opus-');
            assert(sonnetWorktree.branchName.includes('sonnet-'), 'Sonnet branch should include sonnet-');

            // Create the worktrees to verify they work
            await createWorktreeWithGit(git, opusWorktree, 'HEAD');
            await createWorktreeWithGit(git, sonnetWorktree, 'HEAD');

            assert(await fs.pathExists(opusWorktree.worktreePath), 'Opus worktree should exist');
            assert(await fs.pathExists(sonnetWorktree.worktreePath), 'Sonnet worktree should exist');
        });
    });

    describe('Checkout Conflict Handling', () => {
        test('handles creating worktree when branch already exists locally', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 999,
                issueTitle: 'Conflict Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);

            // Pre-create the branch to simulate conflict
            await git.branch([worktreeInfo.branchName]);

            // Try to create worktree - should handle existing branch
            await fs.ensureDir(path.dirname(worktreeInfo.worktreePath));

            // Using -B flag to force branch recreation (similar to production code)
            await git.raw(['worktree', 'add', worktreeInfo.worktreePath, '-B', worktreeInfo.branchName, 'HEAD']);

            // Verify worktree was created despite existing branch
            assert(await fs.pathExists(worktreeInfo.worktreePath), 'Worktree should be created');
            const gitFile = await fs.stat(path.join(worktreeInfo.worktreePath, '.git'));
            assert(gitFile.isFile(), '.git should be a file');
        });

        test('handles creating worktree when directory already exists', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 888,
                issueTitle: 'Dir Exists Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);

            // Pre-create the directory with some content
            await fs.ensureDir(worktreeInfo.worktreePath);
            await fs.writeFile(path.join(worktreeInfo.worktreePath, 'stale-file.txt'), 'stale content');

            // Clean up the existing directory (similar to production flow)
            await fs.remove(worktreeInfo.worktreePath);

            // Now create the worktree
            await fs.ensureDir(path.dirname(worktreeInfo.worktreePath));
            await git.raw(['worktree', 'add', worktreeInfo.worktreePath, '-b', worktreeInfo.branchName, 'HEAD']);

            // Verify worktree was created properly
            assert(await fs.pathExists(worktreeInfo.worktreePath), 'Worktree should exist');
            const gitStats = await fs.stat(path.join(worktreeInfo.worktreePath, '.git'));
            assert(gitStats.isFile(), '.git should be a file');

            // Verify stale content is gone
            const staleFileExists = await fs.pathExists(path.join(worktreeInfo.worktreePath, 'stale-file.txt'));
            assert(!staleFileExists, 'Stale file should not exist after cleanup');
        });

        test('concurrent worktree creation for same issue with different models', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 42,
                issueTitle: 'Concurrent Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            // Create worktrees for different models concurrently
            const opusWorktree = generateWorktreeInfo(issueInfo, 'opus');
            const sonnetWorktree = generateWorktreeInfo(issueInfo, 'sonnet');
            const haikuWorktree = generateWorktreeInfo(issueInfo, 'haiku');

            // Create parent directories
            await Promise.all([
                fs.ensureDir(path.dirname(opusWorktree.worktreePath)),
                fs.ensureDir(path.dirname(sonnetWorktree.worktreePath)),
                fs.ensureDir(path.dirname(haikuWorktree.worktreePath))
            ]);

            // Create worktrees (sequential to avoid git lock issues in test)
            await git.raw(['worktree', 'add', opusWorktree.worktreePath, '-b', opusWorktree.branchName, 'HEAD']);
            await git.raw(['worktree', 'add', sonnetWorktree.worktreePath, '-b', sonnetWorktree.branchName, 'HEAD']);
            await git.raw(['worktree', 'add', haikuWorktree.worktreePath, '-b', haikuWorktree.branchName, 'HEAD']);

            // Verify all worktrees exist
            const worktrees = [opusWorktree, sonnetWorktree, haikuWorktree];
            for (const wt of worktrees) {
                assert(await fs.pathExists(wt.worktreePath), `${wt.branchName} worktree should exist`);
                const gitStats = await fs.stat(path.join(wt.worktreePath, '.git'));
                assert(gitStats.isFile(), `${wt.branchName} .git should be a file`);
            }

            // Verify file isolation - write unique files to each
            await fs.writeFile(path.join(opusWorktree.worktreePath, 'opus.txt'), 'opus work');
            await fs.writeFile(path.join(sonnetWorktree.worktreePath, 'sonnet.txt'), 'sonnet work');
            await fs.writeFile(path.join(haikuWorktree.worktreePath, 'haiku.txt'), 'haiku work');

            // Verify isolation
            const opusFiles = await fs.readdir(opusWorktree.worktreePath);
            assert(opusFiles.includes('opus.txt'), 'Opus should have opus.txt');
            assert(!opusFiles.includes('sonnet.txt'), 'Opus should not have sonnet.txt');
            assert(!opusFiles.includes('haiku.txt'), 'Opus should not have haiku.txt');
        });

        test('worktree branch points to correct HEAD', async () => {
            const git = simpleGit(testRepoPath);

            // Get the current HEAD commit
            const headCommit = await git.revparse(['HEAD']);

            const issueInfo: IssueInfo = {
                issueId: 777,
                issueTitle: 'HEAD Check Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Get the worktree's HEAD commit
            const worktreeGit = simpleGit(worktreeInfo.worktreePath);
            const worktreeHeadCommit = await worktreeGit.revparse(['HEAD']);

            assert.strictEqual(
                worktreeHeadCommit.trim(),
                headCommit.trim(),
                'Worktree HEAD should match main repo HEAD'
            );
        });
    });

    describe('Worktree Cleanup', () => {
        test('worktree can be removed with git worktree remove', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 555,
                issueTitle: 'Cleanup Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Verify worktree exists
            assert(await fs.pathExists(worktreeInfo.worktreePath), 'Worktree should exist before cleanup');

            // Remove the worktree using git command
            await git.raw(['worktree', 'remove', worktreeInfo.worktreePath, '--force']);

            // Verify worktree is removed
            const stillExists = await fs.pathExists(worktreeInfo.worktreePath);
            assert(!stillExists, 'Worktree should not exist after cleanup');
        });

        test('worktree directory can be cleaned via fs.remove', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 666,
                issueTitle: 'FS Cleanup Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Write some files to the worktree
            await fs.writeFile(path.join(worktreeInfo.worktreePath, 'work.txt'), 'work content');

            // Remove via fs (simulating fallback cleanup)
            await fs.remove(worktreeInfo.worktreePath);

            // Verify directory is gone
            assert(!await fs.pathExists(worktreeInfo.worktreePath), 'Worktree directory should be removed');
        });

        test('associated branch can be deleted after worktree removal', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 444,
                issueTitle: 'Branch Cleanup Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Verify branch exists
            const branchesBefore = await git.branch();
            assert(branchesBefore.all.includes(worktreeInfo.branchName), 'Branch should exist before cleanup');

            // Remove worktree
            await git.raw(['worktree', 'remove', worktreeInfo.worktreePath, '--force']);

            // Delete the branch
            await git.branch(['-D', worktreeInfo.branchName]);

            // Verify branch is gone
            const branchesAfter = await git.branch();
            assert(!branchesAfter.all.includes(worktreeInfo.branchName), 'Branch should not exist after deletion');
        });

        test('git worktree list reflects created and removed worktrees', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 333,
                issueTitle: 'List Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);

            // Check worktree list before creation
            const listBefore = await git.raw(['worktree', 'list']);
            assert(!listBefore.includes(worktreeInfo.worktreePath), 'Worktree should not be in list before creation');

            // Create worktree
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Check worktree list after creation
            const listAfter = await git.raw(['worktree', 'list']);
            assert(listAfter.includes(worktreeInfo.worktreePath), 'Worktree should be in list after creation');

            // Remove worktree
            await git.raw(['worktree', 'remove', worktreeInfo.worktreePath, '--force']);

            // Check worktree list after removal
            const listFinal = await git.raw(['worktree', 'list']);
            assert(!listFinal.includes(worktreeInfo.worktreePath), 'Worktree should not be in list after removal');
        });
    });

    describe('Edge Cases', () => {
        test('handles special characters in issue title', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 111,
                issueTitle: 'Fix: Bug #123 - "quotes" & <brackets>!',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);

            // Verify sanitization works
            assert(!worktreeInfo.dirName.includes(':'), 'Dir name should not contain colons');
            assert(!worktreeInfo.dirName.includes('"'), 'Dir name should not contain quotes');
            assert(!worktreeInfo.dirName.includes('<'), 'Dir name should not contain angle brackets');
            assert(!worktreeInfo.dirName.includes('&'), 'Dir name should not contain ampersands');

            // Create the worktree to verify it works
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');
            assert(await fs.pathExists(worktreeInfo.worktreePath), 'Worktree with sanitized name should exist');

            const gitStats = await fs.stat(path.join(worktreeInfo.worktreePath, '.git'));
            assert(gitStats.isFile(), '.git should be a file');
        });

        test('handles very long issue titles', async () => {
            const git = simpleGit(testRepoPath);
            const longTitle = 'This is a very long issue title that exceeds the maximum allowed length and should be truncated properly to avoid file system issues';
            const issueInfo: IssueInfo = {
                issueId: 222,
                issueTitle: longTitle,
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);

            // Verify title is truncated (max 25 chars after sanitization)
            const titlePart = worktreeInfo.branchName.split('/')[1].split('-').slice(0, -3).join('-');
            assert(titlePart.length <= 25, `Sanitized title should be <= 25 chars, got ${titlePart.length}`);

            // Create the worktree
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');
            assert(await fs.pathExists(worktreeInfo.worktreePath), 'Worktree with truncated title should exist');
        });

        test('worktree metadata exists in main repo .git/worktrees', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 1234,
                issueTitle: 'Metadata Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Check that worktree metadata exists in main repo
            const worktreesDir = path.join(testRepoPath, '.git', 'worktrees');
            const metadataExists = await fs.pathExists(worktreesDir);
            assert(metadataExists, '.git/worktrees directory should exist');

            // Get entries in worktrees directory
            const entries = await fs.readdir(worktreesDir);
            assert(entries.length > 0, 'Should have at least one worktree metadata entry');
        });
    });

    describe('Worktree Cleanup with Retention Strategies', () => {
        test('keep_on_failure strategy creates retention marker when success is false', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 5001,
                issueTitle: 'Keep On Failure Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Call cleanupWorktree with keep_on_failure strategy and success=false
            await cleanupWorktree(testRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                deleteBranch: false,
                success: false,
                retentionStrategy: 'keep_on_failure',
                retentionHours: 24
            });

            // Worktree should still exist
            assert(await fs.pathExists(worktreeInfo.worktreePath), 'Worktree should be retained on failure');

            // Retention marker should be created
            const retentionFile = path.join(worktreeInfo.worktreePath, '.retention-info.json');
            assert(await fs.pathExists(retentionFile), 'Retention marker should exist');

            // Verify marker contents
            const retentionInfo = await fs.readJson(retentionFile);
            assert.strictEqual(retentionInfo.success, false);
            assert.strictEqual(retentionInfo.retentionHours, 24);
            assert.strictEqual(retentionInfo.issueProcessed, true);
            assert(retentionInfo.timestamp, 'Should have timestamp');
            assert(retentionInfo.scheduledCleanup, 'Should have scheduledCleanup');
        });

        test('keep_on_failure strategy removes worktree when success is true', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 5002,
                issueTitle: 'Keep On Failure Success Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Call cleanupWorktree with keep_on_failure strategy but success=true
            await cleanupWorktree(testRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                deleteBranch: false,
                success: true,
                retentionStrategy: 'keep_on_failure'
            });

            // Worktree should be removed since success=true
            assert(!await fs.pathExists(worktreeInfo.worktreePath), 'Worktree should be removed on success');
        });

        test('always_delete strategy removes worktree regardless of success', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 5003,
                issueTitle: 'Always Delete Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Call cleanupWorktree with always_delete strategy and success=false
            await cleanupWorktree(testRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                deleteBranch: false,
                success: false,
                retentionStrategy: 'always_delete'
            });

            // Worktree should be removed even on failure with always_delete
            assert(!await fs.pathExists(worktreeInfo.worktreePath), 'Worktree should be removed with always_delete strategy');
        });

        test('keep_for_hours strategy creates marker and then removes worktree', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 5004,
                issueTitle: 'Keep For Hours Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Call cleanupWorktree with keep_for_hours strategy
            await cleanupWorktree(testRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                deleteBranch: false,
                success: false,
                retentionStrategy: 'keep_for_hours',
                retentionHours: 48
            });

            // Worktree should be removed immediately (keep_for_hours still removes, just creates marker first)
            assert(!await fs.pathExists(worktreeInfo.worktreePath), 'Worktree should be removed with keep_for_hours strategy');
        });

        test('retention marker contains correct scheduled cleanup time', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 5005,
                issueTitle: 'Scheduled Cleanup Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            const retentionHours = 12;
            const beforeCall = Date.now();

            await cleanupWorktree(testRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                success: false,
                retentionStrategy: 'keep_on_failure',
                retentionHours
            });

            const afterCall = Date.now();
            const retentionFile = path.join(worktreeInfo.worktreePath, '.retention-info.json');
            const retentionInfo = await fs.readJson(retentionFile);

            // Verify scheduled cleanup time is approximately retentionHours from now
            const scheduledCleanup = new Date(retentionInfo.scheduledCleanup).getTime();
            const expectedMinTime = beforeCall + retentionHours * 60 * 60 * 1000;
            const expectedMaxTime = afterCall + retentionHours * 60 * 60 * 1000;

            assert(scheduledCleanup >= expectedMinTime, 'Scheduled cleanup should be at least retentionHours from call start');
            assert(scheduledCleanup <= expectedMaxTime, 'Scheduled cleanup should be at most retentionHours from call end');
        });
    });

    describe('Expired Worktree Cleanup', () => {
        test('cleanupExpiredWorktrees removes worktrees past scheduled cleanup time', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 6001,
                issueTitle: 'Expired Cleanup Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Create a retention marker with scheduledCleanup in the past
            const retentionInfo = {
                timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
                issueProcessed: true,
                success: false,
                retentionHours: 1,
                scheduledCleanup: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString() // 1 hour ago (expired)
            };
            await fs.writeJson(path.join(worktreeInfo.worktreePath, '.retention-info.json'), retentionInfo);

            // Run cleanup
            const result = await cleanupExpiredWorktrees(worktreesBasePath);

            // Worktree should be cleaned up
            assert(!await fs.pathExists(worktreeInfo.worktreePath), 'Expired worktree should be removed');
            assert.strictEqual(result.cleaned, 1, 'Should report 1 cleaned worktree');
        });

        test('cleanupExpiredWorktrees retains worktrees before scheduled cleanup time', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 6002,
                issueTitle: 'Retained Cleanup Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Create a retention marker with scheduledCleanup in the future
            const retentionInfo = {
                timestamp: new Date().toISOString(),
                issueProcessed: true,
                success: false,
                retentionHours: 24,
                scheduledCleanup: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours from now
            };
            await fs.writeJson(path.join(worktreeInfo.worktreePath, '.retention-info.json'), retentionInfo);

            // Run cleanup
            const result = await cleanupExpiredWorktrees(worktreesBasePath);

            // Worktree should still exist
            assert(await fs.pathExists(worktreeInfo.worktreePath), 'Non-expired worktree should be retained');
            assert.strictEqual(result.retained, 1, 'Should report 1 retained worktree');
            assert.strictEqual(result.cleaned, 0, 'Should report 0 cleaned worktrees');
        });

        test('cleanupExpiredWorktrees handles multiple worktrees with mixed expiration', async () => {
            const git = simpleGit(testRepoPath);

            // Create an expired worktree
            const expiredIssue: IssueInfo = {
                issueId: 6003,
                issueTitle: 'Expired Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };
            const expiredWorktree = generateWorktreeInfo(expiredIssue);
            await createWorktreeWithGit(git, expiredWorktree, 'HEAD');
            await fs.writeJson(path.join(expiredWorktree.worktreePath, '.retention-info.json'), {
                timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
                issueProcessed: true,
                success: false,
                retentionHours: 24,
                scheduledCleanup: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // expired
            });

            // Create a non-expired worktree
            const activeIssue: IssueInfo = {
                issueId: 6004,
                issueTitle: 'Active Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };
            const activeWorktree = generateWorktreeInfo(activeIssue);
            await createWorktreeWithGit(git, activeWorktree, 'HEAD');
            await fs.writeJson(path.join(activeWorktree.worktreePath, '.retention-info.json'), {
                timestamp: new Date().toISOString(),
                issueProcessed: true,
                success: false,
                retentionHours: 48,
                scheduledCleanup: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() // not expired
            });

            // Run cleanup
            const result = await cleanupExpiredWorktrees(worktreesBasePath);

            // Verify results
            assert(!await fs.pathExists(expiredWorktree.worktreePath), 'Expired worktree should be removed');
            assert(await fs.pathExists(activeWorktree.worktreePath), 'Active worktree should be retained');
            assert.strictEqual(result.cleaned, 1, 'Should report 1 cleaned worktree');
            assert.strictEqual(result.retained, 1, 'Should report 1 retained worktree');
        });

        test('cleanupExpiredWorktrees handles non-existent base path gracefully', async () => {
            const nonExistentPath = path.join(tempDir, 'non-existent-worktrees');

            // Should not throw
            const result = await cleanupExpiredWorktrees(nonExistentPath);

            assert.strictEqual(result.cleaned, 0);
            assert.strictEqual(result.retained, 0);
        });

        test('cleanupExpiredWorktrees handles corrupted retention info gracefully', async () => {
            const git = simpleGit(testRepoPath);
            const issueInfo: IssueInfo = {
                issueId: 6005,
                issueTitle: 'Corrupted Info Test',
                owner: 'testowner',
                repoName: 'testrepo'
            };

            const worktreeInfo = generateWorktreeInfo(issueInfo);
            await createWorktreeWithGit(git, worktreeInfo, 'HEAD');

            // Create a corrupted retention marker (invalid JSON)
            await fs.writeFile(path.join(worktreeInfo.worktreePath, '.retention-info.json'), 'invalid json content');

            // Run cleanup - should not throw
            const result = await cleanupExpiredWorktrees(worktreesBasePath);

            // Worktree should be retained since retention info couldn't be read
            assert(await fs.pathExists(worktreeInfo.worktreePath), 'Worktree with corrupted info should be retained');
            assert.strictEqual(result.retained, 1, 'Should report 1 retained worktree');
        });
    });
});
