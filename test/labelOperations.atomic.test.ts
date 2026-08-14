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

test('exclusive convergence restores the prior model label when a later target addition fails', async () => {
    const labels = new Set(['AI', 'llm-claude-opus48']);
    let targetAddAttempts = 0;
    let oldLabelDeleted = false;
    const request = mock.fn(async (endpoint: string, options: Record<string, unknown>) => {
        if (endpoint.startsWith('GET ')) {
            return { data: { labels: [...labels] } };
        }
        if (endpoint.startsWith('POST ')) {
            const [label] = options.labels as string[];
            if (label === 'llm-codex-gpt56-sol') {
                targetAddAttempts += 1;
                if (targetAddAttempts > 1) throw new Error('target label unavailable');
            }
            labels.add(label);
            return {};
        }
        if (endpoint.startsWith('DELETE ')) {
            const label = options.name as string;
            labels.delete(label);
            if (label === 'llm-claude-opus48') {
                oldLabelDeleted = true;
                // Simulate the established target being concurrently removed,
                // forcing the next convergence attempt to add it again.
                labels.delete('llm-codex-gpt56-sol');
            }
            return {};
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await safeUpdateLabels(
        { octokit: { request }, owner: 'integry', repo: 'propr', issueNumber: 42, logger },
        ['llm-claude-opus48'],
        ['llm-codex-gpt56-sol'],
        {
            targetLabel: 'llm-codex-gpt56-sol',
            isManagedLabel: label => label.startsWith('llm-'),
            maxAttempts: 2,
        },
    );

    assert.strictEqual(oldLabelDeleted, true);
    assert.strictEqual(targetAddAttempts, 2);
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual([...labels].sort(), ['AI', 'llm-claude-opus48']);
    assert.deepStrictEqual(result.finalLabels?.sort(), ['AI', 'llm-claude-opus48']);
});

test('exclusive convergence does not restore when the initial model-label snapshot fails', async () => {
    const labels = new Set(['AI', 'llm-claude-opus48']);
    let issueReads = 0;
    const mutations: string[] = [];
    const request = mock.fn(async (endpoint: string, options: Record<string, unknown>) => {
        if (endpoint.startsWith('GET ')) {
            issueReads += 1;
            if (issueReads === 1) throw new Error('initial labels unavailable');
            return { data: { labels: [...labels] } };
        }
        if (endpoint.startsWith('DELETE ')) {
            mutations.push(endpoint);
            labels.delete(options.name as string);
            return {};
        }
        if (endpoint.startsWith('POST ')) {
            mutations.push(endpoint);
            labels.add((options.labels as string[])[0]);
            return {};
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await safeUpdateLabels(
        { octokit: { request }, owner: 'integry', repo: 'propr', issueNumber: 42, logger },
        ['llm-claude-opus48'],
        ['llm-codex-gpt56-sol'],
        {
            targetLabel: 'llm-codex-gpt56-sol',
            isManagedLabel: label => label.startsWith('llm-'),
            maxAttempts: 1,
        },
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(issueReads, 1);
    assert.deepStrictEqual(mutations, []);
    assert.deepStrictEqual([...labels].sort(), ['AI', 'llm-claude-opus48']);
});

test('exclusive convergence removes an introduced target when verification fails with no prior model label', async () => {
    const labels = new Set(['AI']);
    let issueReads = 0;
    const request = mock.fn(async (endpoint: string, options: Record<string, unknown>) => {
        if (endpoint.startsWith('GET ')) {
            issueReads += 1;
            if (issueReads === 2) throw new Error('verification unavailable');
            return { data: { labels: [...labels] } };
        }
        if (endpoint.startsWith('POST ')) {
            labels.add((options.labels as string[])[0]);
            return {};
        }
        if (endpoint.startsWith('DELETE ')) {
            labels.delete(options.name as string);
            return {};
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const result = await safeUpdateLabels(
        { octokit: { request }, owner: 'integry', repo: 'propr', issueNumber: 42, logger },
        [],
        ['llm-codex-gpt56-sol'],
        {
            targetLabel: 'llm-codex-gpt56-sol',
            isManagedLabel: label => label.startsWith('llm-'),
            maxAttempts: 1,
        },
    );

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual([...labels], ['AI']);
    assert.deepStrictEqual(result.finalLabels, ['AI']);
});
