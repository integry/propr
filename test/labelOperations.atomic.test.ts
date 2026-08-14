import { test, mock } from 'node:test';
import assert from 'node:assert';
import { safeUpdateLabels } from '../packages/core/src/utils/github/labelOperations.js';

const logger = {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
} as never;

test('safeUpdateLabels atomically replaces a known current label set', async () => {
    const request = mock.fn(async () => ({}));
    const result = await safeUpdateLabels(
        { octokit: { request }, owner: 'integry', repo: 'propr', issueNumber: 42, logger },
        ['llm-claude-opus48'],
        ['llm-codex-gpt56-sol'],
        ['AI', 'bug', 'llm-claude-opus48'],
    );

    assert.strictEqual(request.mock.callCount(), 1);
    assert.strictEqual(request.mock.calls[0].arguments[0], 'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels');
    assert.deepStrictEqual(request.mock.calls[0].arguments[1].labels, ['AI', 'bug', 'llm-codex-gpt56-sol']);
    assert.strictEqual(result.success, true);
});

test('safeUpdateLabels reports an atomic replacement failure without partial calls', async () => {
    const request = mock.fn(async () => { throw new Error('label update denied'); });
    const result = await safeUpdateLabels(
        { octokit: { request }, owner: 'integry', repo: 'propr', issueNumber: 42, logger },
        ['llm-claude-opus48'],
        ['llm-codex-gpt56-sol'],
        ['AI', 'llm-claude-opus48'],
    );

    assert.strictEqual(request.mock.callCount(), 1);
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.removed, []);
    assert.deepStrictEqual(result.added, []);
});
