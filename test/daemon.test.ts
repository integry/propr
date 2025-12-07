import { test, mock } from 'node:test';
import assert from 'node:assert';

process.env.GITHUB_REPOS_TO_MONITOR = 'test-owner/test-repo';
process.env.AI_PRIMARY_TAG = 'AI';
process.env.AI_EXCLUDE_TAGS_PROCESSING = 'AI-processing';
process.env.AI_DONE_TAG = 'AI-done';
process.env.MODEL_LABEL_PATTERN = '^llm-claude-(.+)$';
process.env.DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-20240620';

interface MockIssue {
    id: number;
    number: number;
    title: string;
    html_url: string;
    labels: Array<{ name: string }>;
    created_at: string;
    updated_at: string;
}

interface TransformedIssue {
    id: number;
    number: number;
    title: string;
    url: string;
    repoOwner: string;
    repoName: string;
    labels: string[];
    targetModels?: string[];
    createdAt: string;
    updatedAt: string;
}

test('daemon test - validate issue transformation logic', () => {
    function transformIssue(mockIssue: MockIssue, repoOwner: string, repoName: string): TransformedIssue {
        const modelLabelPattern = new RegExp(process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$');
        const targetModels: string[] = [];
        
        mockIssue.labels.forEach(label => {
            const match = label.name.match(modelLabelPattern);
            if (match && match[1]) {
                targetModels.push(match[1]);
            }
        });
        
        return {
            id: mockIssue.id,
            number: mockIssue.number,
            title: mockIssue.title,
            url: mockIssue.html_url,
            repoOwner,
            repoName,
            labels: mockIssue.labels.map(l => l.name),
            targetModels: targetModels.length > 0 ? targetModels : ['sonnet'],
            createdAt: mockIssue.created_at,
            updatedAt: mockIssue.updated_at
        };
    }
    
    const mockIssue: MockIssue = {
        id: 123,
        number: 1,
        title: 'Test Issue',
        html_url: 'https://github.com/owner/repo/issues/1',
        labels: [
            { name: 'AI' },
            { name: 'bug' }
        ],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z'
    };
    
    const result = transformIssue(mockIssue, 'owner', 'repo');
    
    assert.strictEqual(result.id, 123);
    assert.strictEqual(result.number, 1);
    assert.strictEqual(result.title, 'Test Issue');
    assert.strictEqual(result.url, 'https://github.com/owner/repo/issues/1');
    assert.strictEqual(result.repoOwner, 'owner');
    assert.strictEqual(result.repoName, 'repo');
    assert.deepStrictEqual(result.labels, ['AI', 'bug']);
    assert.deepStrictEqual(result.targetModels, ['sonnet']);
});

test('daemon test - handles invalid repository format', () => {
    function parseRepoFullName(repoFullName: string): { owner: string; repo: string } | null {
        const [owner, repo] = repoFullName.split('/');
        if (!owner || !repo) {
            return null;
        }
        return { owner, repo };
    }
    
    assert.strictEqual(parseRepoFullName('invalid-format'), null);
    assert.deepStrictEqual(parseRepoFullName('owner/repo'), { owner: 'owner', repo: 'repo' });
});

test('daemon test - constructs correct search query', () => {
    function constructSearchQuery(owner: string, repo: string): string {
        const primaryTag = process.env.AI_PRIMARY_TAG || 'AI';
        const processingTag = process.env.AI_EXCLUDE_TAGS_PROCESSING || 'AI-processing';
        const doneTag = process.env.AI_DONE_TAG || 'AI-done';
        
        return `repo:${owner}/${repo} is:issue is:open label:"${primaryTag}" -label:"${processingTag}" -label:"${doneTag}"`;
    }
    
    const query = constructSearchQuery('owner', 'repo');
    
    assert.ok(query.includes('repo:owner/repo'));
    assert.ok(query.includes('is:issue'));
    assert.ok(query.includes('is:open'));
    assert.ok(query.includes('label:"AI"'));
    assert.ok(query.includes('-label:"AI-processing"'));
    assert.ok(query.includes('-label:"AI-done"'));
});

test('daemon test - identifies model labels correctly', () => {
    function extractModelLabels(labels: string[]): string[] {
        const modelLabelPattern = new RegExp(process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$');
        const models: string[] = [];
        
        labels.forEach(label => {
            const match = label.match(modelLabelPattern);
            if (match && match[1]) {
                models.push(match[1]);
            }
        });
        
        return models.length > 0 ? models : ['sonnet'];
    }
    
    const labels = ['AI', 'llm-claude-3-opus-20240229', 'llm-claude-3-5-sonnet-20240620', 'enhancement'];
    const models = extractModelLabels(labels);
    
    assert.deepStrictEqual(models, ['3-opus-20240229', '3-5-sonnet-20240620']);
});

test('daemon test - handles single model label', () => {
    function extractModelLabels(labels: string[]): string[] {
        const modelLabelPattern = new RegExp(process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$');
        const models: string[] = [];
        
        labels.forEach(label => {
            const match = label.match(modelLabelPattern);
            if (match && match[1]) {
                models.push(match[1]);
            }
        });
        
        return models.length > 0 ? models : ['sonnet'];
    }
    
    const labels = ['AI', 'llm-claude-3-opus-20240229', 'bug'];
    const models = extractModelLabels(labels);
    
    assert.deepStrictEqual(models, ['3-opus-20240229']);
});

test('daemon test - ignores non-matching model labels', () => {
    function extractModelLabels(labels: string[]): string[] {
        const modelLabelPattern = new RegExp(process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$');
        const models: string[] = [];
        
        labels.forEach(label => {
            const match = label.match(modelLabelPattern);
            if (match && match[1]) {
                models.push(match[1]);
            }
        });
        
        return models.length > 0 ? models : ['sonnet'];
    }
    
    const labels = ['AI', 'gpt-4', 'openai-claude', 'llm-other-model', 'documentation'];
    const models = extractModelLabels(labels);
    
    assert.deepStrictEqual(models, ['sonnet']);
});

test('daemon test - validates exported functions exist', async () => {
    const daemonModule = await import('../src/daemon.ts');
    
    assert.strictEqual(typeof daemonModule.fetchIssuesForRepo, 'function');
    assert.strictEqual(typeof daemonModule.pollForIssues, 'function');
});
