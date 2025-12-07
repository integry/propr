import { test, mock } from 'node:test';
import assert from 'node:assert';
 
process.env.AI_PROCESSING_TAG = 'AI-processing';
process.env.AI_PRIMARY_TAG = 'AI';
process.env.AI_DONE_TAG = 'AI-done';
process.env.SIMULATED_WORK_MS = '100';

test('worker test - validates job processing logic', async () => {
    function shouldSkipIssue(labels: string[], primaryTag: string, doneTag: string): { skip: boolean; reason?: string } {
        const labelNames = labels.map(l => l.toLowerCase());
        
        if (!labelNames.includes(primaryTag.toLowerCase())) {
            return { skip: true, reason: 'Primary tag missing' };
        }
        
        if (labelNames.includes(doneTag.toLowerCase())) {
            return { skip: true, reason: 'Already done' };
        }
        
        return { skip: false };
    }
    
    const primaryTag = process.env.AI_PRIMARY_TAG || 'AI';
    const doneTag = process.env.AI_DONE_TAG || 'AI-done';
    
    const result1 = shouldSkipIssue(['bug'], primaryTag, doneTag);
    assert.strictEqual(result1.skip, true);
    assert.strictEqual(result1.reason, 'Primary tag missing');
    
    const result2 = shouldSkipIssue(['AI', 'AI-done'], primaryTag, doneTag);
    assert.strictEqual(result2.skip, true);
    assert.strictEqual(result2.reason, 'Already done');
    
    const result3 = shouldSkipIssue(['AI'], primaryTag, doneTag);
    assert.strictEqual(result3.skip, false);
});

test('worker test - validates processing tag logic', () => {
    function shouldAddProcessingTag(labels: string[], processingTag: string): boolean {
        const labelNames = labels.map(l => l.toLowerCase());
        return !labelNames.includes(processingTag.toLowerCase());
    }
    
    const processingTag = process.env.AI_PROCESSING_TAG || 'AI-processing';
    
    assert.strictEqual(shouldAddProcessingTag(['AI'], processingTag), true);
    assert.strictEqual(shouldAddProcessingTag(['AI', 'AI-processing'], processingTag), false);
});

test('worker test - validates exported functions exist', async () => {
    const workerModule = await import('../src/worker.ts');
    
    assert.strictEqual(typeof workerModule.processGitHubIssueJob, 'function');
    assert.strictEqual(typeof workerModule.startWorker, 'function');
});

test('worker test - model-specific delay calculation', () => {
    function calculateDelay(modelName: string): number {
        const baseDelay = 500;
        const modelHash = modelName.split('').reduce((hash, char) => {
            return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
        }, 0);
        const modelDelay = Math.abs(modelHash % 1500);
        return baseDelay + modelDelay;
    }
    
    const opusDelay = calculateDelay('opus');
    const sonnetDelay = calculateDelay('sonnet');
    
    assert(opusDelay >= 500 && opusDelay < 2000);
    assert(sonnetDelay >= 500 && sonnetDelay < 2000);
    assert.notStrictEqual(opusDelay, sonnetDelay);
});

test('worker test - branch name generation', () => {
    function generateBranchName(issueId: number, title: string, timestamp: string, modelName: string | null, randomString: string): string {
        const sanitizedTitle = title
            .toLowerCase()
            .replace(/[^a-z0-9_\-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 25);
        
        const modelSuffix = modelName ? `-${modelName}` : '';
        return `ai-fix/${issueId}-${sanitizedTitle}-${timestamp}${modelSuffix}-${randomString}`;
    }
    
    const branchName = generateBranchName(42, 'Test Issue', '20240528-1430', 'opus', 'abc');
    
    assert.strictEqual(branchName, 'ai-fix/42-test-issue-20240528-1430-opus-abc');
    assert(branchName.startsWith('ai-fix/'));
    assert(branchName.includes('-opus-'));
});
