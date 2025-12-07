import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

interface WorktreeInfo {
    worktreePath: string;
    branchName: string;
    modelName: string;
}

interface ExecutionResult {
    model: string;
    startOffset: number;
    duration: number;
    endOffset: number;
}

interface JobResult {
    jobId: string;
    modelName: string;
    status: string;
    worktreePath: string;
}

describe('Worker Integration - Concurrent Model Execution', () => {
    let tempDir: string;
    let originalEnv: NodeJS.ProcessEnv;
    
    beforeEach(async () => {
        originalEnv = { ...process.env };
        
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitfix-integration-'));
        
        process.env.WORKTREES_BASE_PATH = path.join(tempDir, 'worktrees');
        process.env.GIT_PROCESSOR_PATH = path.join(tempDir, 'git-processor');
        process.env.AI_PROCESSING_TAG = 'AI-processing';
        process.env.AI_PRIMARY_TAG = 'AI';
        process.env.AI_DONE_TAG = 'AI-done';
        
        await fs.ensureDir(process.env.WORKTREES_BASE_PATH);
        await fs.ensureDir(process.env.GIT_PROCESSOR_PATH);
    });
    
    afterEach(async () => {
        process.env = originalEnv;
        
        if (tempDir) {
            await fs.remove(tempDir);
        }
    });
    
    test('concurrent jobs with different models create unique worktrees', async () => {
        function simulateWorktreeCreation(issueId: number, issueTitle: string, modelName: string): WorktreeInfo {
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
            const branchName = `ai-fix/${issueId}-${sanitizedTitle}-${shortTimestamp}${modelSuffix}-${randomString}`;
            const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelSuffix}-${randomString}`;
            const worktreePath = path.join(process.env.WORKTREES_BASE_PATH!, 'testuser', 'testrepo', worktreeDirName);
            
            return { worktreePath, branchName, modelName };
        }
        
        const issueId = 42;
        const issueTitle = 'Test Concurrent Issue';
        
        const opusWorktree = simulateWorktreeCreation(issueId, issueTitle, 'opus');
        const sonnetWorktree = simulateWorktreeCreation(issueId, issueTitle, 'sonnet');
        
        assert.notStrictEqual(opusWorktree.worktreePath, sonnetWorktree.worktreePath);
        assert.notStrictEqual(opusWorktree.branchName, sonnetWorktree.branchName);
        
        assert(opusWorktree.branchName.includes('-opus-'));
        assert(sonnetWorktree.branchName.includes('-sonnet-'));
        assert(opusWorktree.worktreePath.includes('-opus-'));
        assert(sonnetWorktree.worktreePath.includes('-sonnet-'));
        
        await fs.ensureDir(opusWorktree.worktreePath);
        await fs.ensureDir(sonnetWorktree.worktreePath);
        
        await fs.writeFile(path.join(opusWorktree.worktreePath, 'opus-file.txt'), 'opus work');
        await fs.writeFile(path.join(sonnetWorktree.worktreePath, 'sonnet-file.txt'), 'sonnet work');
        
        const opusFiles = await fs.readdir(opusWorktree.worktreePath);
        const sonnetFiles = await fs.readdir(sonnetWorktree.worktreePath);
        
        assert(opusFiles.includes('opus-file.txt'));
        assert(!opusFiles.includes('sonnet-file.txt'));
        
        assert(sonnetFiles.includes('sonnet-file.txt'));
        assert(!sonnetFiles.includes('opus-file.txt'));
    });
    
    test('delay function prevents exact simultaneous execution', async () => {
        function addModelSpecificDelay(modelName: string): Promise<void> {
            const baseDelay = 100;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 200);
            const totalDelay = baseDelay + modelDelay;
            
            return new Promise(resolve => setTimeout(resolve, totalDelay));
        }
        
        const models = ['opus', 'sonnet', 'claude-3', 'gpt-4'];
        
        const startTime = Date.now();
        const promises = models.map(async (model): Promise<ExecutionResult> => {
            const modelStartTime = Date.now();
            await addModelSpecificDelay(model);
            const modelEndTime = Date.now();
            return {
                model,
                startOffset: modelStartTime - startTime,
                duration: modelEndTime - modelStartTime,
                endOffset: modelEndTime - startTime
            };
        });
        
        const results = await Promise.all(promises);
        
        assert.strictEqual(results.length, models.length);
        
        const durations = results.map(r => r.duration);
        const uniqueDurations = new Set(durations);
        assert(uniqueDurations.size > 1, 'Models should have different delay durations');
        
        durations.forEach((duration, index) => {
            assert(duration >= 90, `Model ${models[index]} duration too short: ${duration}ms`);
            assert(duration < 350, `Model ${models[index]} duration too long: ${duration}ms`);
        });
        
        const startOffsets = results.map(r => r.startOffset);
        const maxStartOffset = Math.max(...startOffsets);
        assert(maxStartOffset < 50, 'All should start within reasonable time of each other');
    });
    
    test('worktree cleanup after concurrent execution', async () => {
        const owner = 'testuser';
        const repoName = 'testrepo';
        const issueId = 42;
        
        const worktreePaths: string[] = [];
        for (const model of ['opus', 'sonnet']) {
            const randomString = Math.random().toString(36).substring(2, 5);
            const timestamp = '20240528-1430';
            const dirName = `issue-${issueId}-${timestamp}-${model}-${randomString}`;
            const worktreePath = path.join(process.env.WORKTREES_BASE_PATH!, owner, repoName, dirName);
            
            await fs.ensureDir(worktreePath);
            await fs.writeFile(path.join(worktreePath, 'test.txt'), 'test content');
            
            worktreePaths.push(worktreePath);
        }
        
        for (const worktreePath of worktreePaths) {
            const exists = await fs.pathExists(worktreePath);
            assert(exists, `Worktree should exist before cleanup: ${worktreePath}`);
        }
        
        for (const worktreePath of worktreePaths) {
            await fs.remove(worktreePath);
        }
        
        for (const worktreePath of worktreePaths) {
            const exists = await fs.pathExists(worktreePath);
            assert(!exists, `Worktree should be cleaned up: ${worktreePath}`);
        }
    });
    
    test('file system isolation between concurrent workers', async () => {
        const baseDir = process.env.WORKTREES_BASE_PATH!;
        const owner = 'testuser';
        const repoName = 'testrepo';
        
        const opusDir = path.join(baseDir, owner, repoName, 'issue-42-20240528-1430-opus-abc');
        const sonnetDir = path.join(baseDir, owner, repoName, 'issue-42-20240528-1430-sonnet-xyz');
        
        await fs.ensureDir(opusDir);
        await fs.ensureDir(sonnetDir);
        
        await fs.writeFile(path.join(opusDir, 'opus-work.txt'), 'opus is working on this issue');
        await fs.writeFile(path.join(sonnetDir, 'sonnet-work.txt'), 'sonnet is working on this issue');
        
        const opusFiles = await fs.readdir(opusDir);
        const sonnetFiles = await fs.readdir(sonnetDir);
        
        assert(opusFiles.includes('opus-work.txt'));
        assert(!opusFiles.includes('sonnet-work.txt'));
        
        assert(sonnetFiles.includes('sonnet-work.txt'));
        assert(!sonnetFiles.includes('opus-work.txt'));
        
        const opusContent = await fs.readFile(path.join(opusDir, 'opus-work.txt'), 'utf8');
        const sonnetContent = await fs.readFile(path.join(sonnetDir, 'sonnet-work.txt'), 'utf8');
        
        assert.strictEqual(opusContent, 'opus is working on this issue');
        assert.strictEqual(sonnetContent, 'sonnet is working on this issue');
        
        await Promise.all([
            fs.writeFile(path.join(opusDir, 'concurrent-opus.txt'), 'opus concurrent operation'),
            fs.writeFile(path.join(sonnetDir, 'concurrent-sonnet.txt'), 'sonnet concurrent operation')
        ]);
        
        const opusExists = await fs.pathExists(path.join(opusDir, 'concurrent-opus.txt'));
        const sonnetExists = await fs.pathExists(path.join(sonnetDir, 'concurrent-sonnet.txt'));
        
        assert(opusExists, 'Opus concurrent file should exist');
        assert(sonnetExists, 'Sonnet concurrent file should exist');
        
        const opusCrossFile = await fs.pathExists(path.join(opusDir, 'concurrent-sonnet.txt'));
        const sonnetCrossFile = await fs.pathExists(path.join(sonnetDir, 'concurrent-opus.txt'));
        
        assert(!opusCrossFile, 'Sonnet file should not appear in opus directory');
        assert(!sonnetCrossFile, 'Opus file should not appear in sonnet directory');
    });
    
    test('error handling in concurrent execution', async () => {
        function simulateJobExecution(jobId: string, modelName: string, shouldFail = false): Promise<JobResult> {
            return new Promise((resolve, reject) => {
                setTimeout(() => {
                    if (shouldFail) {
                        reject(new Error(`${modelName} job failed`));
                    } else {
                        resolve({
                            jobId,
                            modelName,
                            status: 'completed',
                            worktreePath: path.join(tempDir, 'worktrees', 'testuser', 'testrepo', `issue-42-${modelName}-abc`)
                        });
                    }
                }, Math.random() * 100);
            });
        }
        
        const results = await Promise.allSettled([
            simulateJobExecution('job-opus', 'opus', true),
            simulateJobExecution('job-sonnet', 'sonnet', false)
        ]);
        
        assert.strictEqual(results.length, 2);
        
        const opusResult = results[0];
        const sonnetResult = results[1];
        
        assert.strictEqual(opusResult.status, 'rejected');
        if (opusResult.status === 'rejected') {
            assert((opusResult.reason as Error).message.includes('opus job failed'));
        }
        
        assert.strictEqual(sonnetResult.status, 'fulfilled');
        if (sonnetResult.status === 'fulfilled') {
            assert.strictEqual(sonnetResult.value.status, 'completed');
            assert.strictEqual(sonnetResult.value.modelName, 'sonnet');
        }
        
        assert.notStrictEqual(opusResult.status, sonnetResult.status);
    });
});
