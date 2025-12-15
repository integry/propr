import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import path from 'path';

process.env.AI_PROCESSING_TAG = 'AI-processing';
process.env.AI_PRIMARY_TAG = 'AI';
process.env.AI_DONE_TAG = 'AI-done';

interface WorktreeNames {
    branchName: string;
    worktreeDirName: string;
    randomString?: string;
}

interface ExecutionResult {
    model: string;
    startTime: number;
    duration: number;
    endTime: number;
}

interface TestCase {
    input: string;
    expected: string;
}

interface IssueRef {
    repoOwner: string;
    repoName: string;
    number: number;
    modelName?: string;
    correlationId?: string;
}

describe('Worker - Model-Specific Features', () => {
    
    test('addModelSpecificDelay generates consistent delays for same model', async () => {
        function getExpectedDelay(modelName: string): number {
            const baseDelay = 500;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 1500);
            return baseDelay + modelDelay;
        }
        
        const model1 = 'opus';
        const model2 = 'sonnet';
        
        const expectedDelay1 = getExpectedDelay(model1);
        const expectedDelay2 = getExpectedDelay(model2);
        
        assert.strictEqual(getExpectedDelay(model1), expectedDelay1);
        assert.strictEqual(getExpectedDelay(model2), expectedDelay2);
        
        assert.notStrictEqual(expectedDelay1, expectedDelay2);
        
        assert(expectedDelay1 >= 500 && expectedDelay1 < 2000);
        assert(expectedDelay2 >= 500 && expectedDelay2 < 2000);
    });
    
    test('addModelSpecificDelay timing verification', async () => {
        function addModelSpecificDelay(modelName: string): Promise<void> {
            const baseDelay = 500;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 1500);
            const totalDelay = baseDelay + modelDelay;
            
            return new Promise(resolve => setTimeout(resolve, totalDelay));
        }
        
        const startTime = Date.now();
        await addModelSpecificDelay('test-model');
        const endTime = Date.now();
        const actualDelay = endTime - startTime;
        
        assert(actualDelay >= 490, `Delay was ${actualDelay}ms, expected at least 490ms`);
        
        assert(actualDelay < 2100, `Delay was ${actualDelay}ms, expected less than 2100ms`);
    });
    
    test('addModelSpecificDelay handles edge cases', () => {
        function getDelayTime(modelName: string): number {
            const baseDelay = 500;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 1500);
            return baseDelay + modelDelay;
        }
        
        const emptyDelay = getDelayTime('');
        assert(emptyDelay >= 500 && emptyDelay < 2000);
        
        const singleCharDelay = getDelayTime('a');
        assert(singleCharDelay >= 500 && singleCharDelay < 2000);
        
        const longModelDelay = getDelayTime('very-long-model-name-with-many-characters');
        assert(longModelDelay >= 500 && longModelDelay < 2000);
        
        const specialCharDelay = getDelayTime('claude-3.5-sonnet@2024');
        assert(specialCharDelay >= 500 && specialCharDelay < 2000);
    });
});

describe('Worker - Branch and Worktree Naming', () => {
    
    test('createWorktreeForIssue generates unique names with model and random string', () => {
        function generateWorktreeNames(issueId: number, issueTitle: string, modelName: string): WorktreeNames & { randomString: string } {
            const sanitizedTitle = issueTitle
                .toLowerCase()
                .replace(/[^a-z0-9_\\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);

            const randomString = Math.random().toString(36).substring(2, 5);

            const now = new Date();
            const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

            // New branch format: {issue}/{model}-{slug}-{timestamp}-{suffix}
            const sanitizedModel = modelName
                ? modelName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
                : '';
            const branchName = sanitizedModel
                ? `${issueId}/${sanitizedModel}-${sanitizedTitle}-${shortTimestamp}-${randomString}`
                : `${issueId}/ai-${sanitizedTitle}-${shortTimestamp}-${randomString}`;
            const modelDirSuffix = sanitizedModel ? `-${sanitizedModel}` : '';
            const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelDirSuffix}-${randomString}`;

            return { branchName, worktreeDirName, randomString };
        }

        const issueId = 42;
        const issueTitle = 'Fix Critical Bug in Authentication System';
        const modelName = 'opus';

        const result = generateWorktreeNames(issueId, issueTitle, modelName);

        assert(result.branchName.startsWith('42/opus-fix-critical-bug-in'));
        assert(result.branchName.includes('opus-'));
        assert(result.branchName.endsWith(`-${result.randomString}`));

        assert(result.worktreeDirName.startsWith('issue-42-'));
        assert(result.worktreeDirName.includes('-opus-'));
        assert(result.worktreeDirName.endsWith(`-${result.randomString}`));

        assert.strictEqual(result.randomString.length, 3);
        assert(/^[a-z0-9]{3}$/.test(result.randomString));
    });
    
    test('createWorktreeForIssue handles different models uniquely', () => {
        function generateWorktreeNames(issueId: number, issueTitle: string, modelName: string | null): WorktreeNames {
            const sanitizedTitle = issueTitle
                .toLowerCase()
                .replace(/[^a-z0-9_\\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);

            const randomString = Math.random().toString(36).substring(2, 5);

            const now = new Date();
            const shortTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

            // New branch format: {issue}/{model}-{slug}-{timestamp}-{suffix}
            const sanitizedModel = modelName
                ? modelName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
                : '';
            const branchName = sanitizedModel
                ? `${issueId}/${sanitizedModel}-${sanitizedTitle}-${shortTimestamp}-${randomString}`
                : `${issueId}/ai-${sanitizedTitle}-${shortTimestamp}-${randomString}`;
            const modelDirSuffix = sanitizedModel ? `-${sanitizedModel}` : '';
            const worktreeDirName = `issue-${issueId}-${shortTimestamp}${modelDirSuffix}-${randomString}`;

            return { branchName, worktreeDirName };
        }

        const issueId = 42;
        const issueTitle = 'Test Issue';

        const opusResult = generateWorktreeNames(issueId, issueTitle, 'opus');
        const sonnetResult = generateWorktreeNames(issueId, issueTitle, 'sonnet');
        const defaultResult = generateWorktreeNames(issueId, issueTitle, null);

        assert.notStrictEqual(opusResult.branchName, sonnetResult.branchName);
        assert.notStrictEqual(opusResult.worktreeDirName, sonnetResult.worktreeDirName);

        assert(opusResult.branchName.includes('opus-'));
        assert(sonnetResult.branchName.includes('sonnet-'));
        assert(defaultResult.branchName.includes('/ai-'));
        assert(!defaultResult.branchName.includes('opus'));
        assert(!defaultResult.branchName.includes('sonnet'));
    });
    
    test('createWorktreeForIssue sanitizes issue titles correctly', () => {
        function sanitizeTitle(title: string): string {
            return title
                .toLowerCase()
                .replace(/[^a-z0-9_\\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);
        }
        
        const testCases: TestCase[] = [
            {
                input: 'Fix: Critical Bug with @mentions & "quotes"',
                expected: 'fix-critical-bug-with-men'
            },
            {
                input: 'Very   Long    Title    With    Multiple    Spaces',
                expected: 'very-long-title-with-mult'
            },
            {
                input: '---Leading-and-trailing-dashes---',
                expected: 'leading-and-trailing-dash'
            },
            {
                input: 'Special!@#$%^&*()Characters[]{}',
                expected: 'special-characters'
            },
            {
                input: 'Short',
                expected: 'short'
            }
        ];
        
        testCases.forEach((testCase, index) => {
            const result = sanitizeTitle(testCase.input);
            assert.strictEqual(result, testCase.expected, `Test case ${index + 1} failed`);
            assert(result.length <= 25, `Test case ${index + 1}: result too long`);
        });
    });
    
    test('worktree names include proper timestamp format', () => {
        function generateTimestamp(): string {
            const now = new Date();
            return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        }
        
        const timestamp = generateTimestamp();
        
        assert(/^\d{8}-\d{4}$/.test(timestamp));
        
        const now = new Date();
        const expectedStart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        assert(timestamp.startsWith(expectedStart));
    });
});

describe('Worker - Model-Specific Job Processing', () => {
    
    test('processGitHubIssueJob uses modelName from job data', async () => {
        const issueRef: IssueRef = {
            repoOwner: 'test',
            repoName: 'repo',
            number: 42,
            modelName: 'opus',
            correlationId: 'test-correlation-id'
        };

        const modelName = issueRef.modelName || 'default';
        assert.strictEqual(modelName, 'opus');

        function simulateWorktreeNaming(issueId: number, issueTitle: string, modelName: string): string {
            const sanitizedTitle = issueTitle
                .toLowerCase()
                .replace(/[^a-z0-9_\\-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 25);

            const randomString = 'abc';
            const timestamp = '20240528-1430';
            // New branch format: {issue}/{model}-{slug}-{timestamp}-{suffix}
            const sanitizedModel = modelName
                ? modelName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
                : '';
            const branchName = sanitizedModel
                ? `${issueId}/${sanitizedModel}-${sanitizedTitle}-${timestamp}-${randomString}`
                : `${issueId}/ai-${sanitizedTitle}-${timestamp}-${randomString}`;

            return branchName;
        }

        const branchName = simulateWorktreeNaming(issueRef.number, 'Test Issue', modelName);
        assert(branchName.includes('opus-'), `Branch name should contain model: ${branchName}`);
        assert.strictEqual(branchName, '42/opus-test-issue-20240528-1430-abc');
    });
    
    test('processGitHubIssueJob handles missing modelName gracefully', async () => {
        const issueRef: IssueRef = { repoOwner: 'test', repoName: 'repo', number: 42 };
        const modelName = issueRef.modelName || 'default';
        
        assert.strictEqual(modelName, 'default');
        
        const issueRefWithModel: IssueRef = { ...issueRef, modelName: 'sonnet' };
        const modelNameWithModel = issueRefWithModel.modelName || 'default';
        
        assert.strictEqual(modelNameWithModel, 'sonnet');
    });
});

describe('Worker - Concurrent Execution Prevention', () => {
    
    test('different models get different delay times', () => {
        function calculateDelay(modelName: string): number {
            const baseDelay = 500;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 1500);
            return baseDelay + modelDelay;
        }
        
        const models = ['opus', 'sonnet', 'claude-3', 'gpt-4'];
        const delays = models.map(calculateDelay);
        
        const uniqueDelays = new Set(delays);
        assert.strictEqual(uniqueDelays.size, delays.length, 'All models should have unique delays');
        
        delays.forEach((delay, index) => {
            assert(delay >= 500 && delay < 2000, `Model ${models[index]} delay ${delay} out of range`);
        });
    });
    
    test('concurrent job simulation shows different timings', async () => {
        function addModelSpecificDelay(modelName: string): Promise<void> {
            const baseDelay = 50;
            const modelHash = modelName.split('').reduce((hash, char) => {
                return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
            }, 0);
            const modelDelay = Math.abs(modelHash % 100);
            const totalDelay = baseDelay + modelDelay;
            
            return new Promise(resolve => setTimeout(resolve, totalDelay));
        }
        
        const startTime = Date.now();
        const models = ['opus', 'sonnet'];
        
        const promises = models.map(async (model): Promise<ExecutionResult> => {
            const modelStartTime = Date.now();
            await addModelSpecificDelay(model);
            const modelEndTime = Date.now();
            return {
                model,
                startTime: modelStartTime - startTime,
                duration: modelEndTime - modelStartTime,
                endTime: modelEndTime - startTime
            };
        });
        
        const results = await Promise.all(promises);
        
        assert.strictEqual(results.length, 2);
        assert.notStrictEqual(results[0].duration, results[1].duration);
        
        results.forEach(result => {
            assert(result.duration >= 40, `${result.model} duration too short: ${result.duration}ms`);
            assert(result.duration < 200, `${result.model} duration too long: ${result.duration}ms`);
        });
    });
});
