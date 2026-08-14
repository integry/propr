import { test, mock } from 'node:test';
import assert from 'node:assert';
import { safeUpdateLabels } from '../packages/core/src/utils/github/labelOperations.js';

const logger = {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
} as never;

function createTransitionRedis() {
    const store = new Map<string, string>();
    return {
        async set(key: string, value: string, _mode: string, _ttl: number, condition: string) {
            if (condition === 'NX' && store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        },
        async eval(script: string, _keyCount: number, key: string, token: string) {
            if (store.get(key) !== token) return 0;
            if (script.includes("redis.call('PEXPIRE'")) return 1;
            store.delete(key);
            return 1;
        },
    };
}

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
            redis: createTransitionRedis() as never,
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
            redis: createTransitionRedis() as never,
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
            redis: createTransitionRedis() as never,
        },
    );

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual([...labels], ['AI']);
    assert.deepStrictEqual(result.finalLabels, ['AI']);
});

test('failed transition rollback preserves a newer verified singleton when B starts before rollback', async () => {
    const labels = new Set(['AI', 'llm-claude-opus48']);
    const redis = createTransitionRedis();
    let runningNewerTransition = false;
    let startedNewerTransition = false;
    let newerPromise: Promise<Awaited<ReturnType<typeof safeUpdateLabels>>> | undefined;
    let newerResult: Awaited<ReturnType<typeof safeUpdateLabels>> | undefined;
    const context = { octokit: { request: undefined as never }, owner: 'integry', repo: 'propr', issueNumber: 42, logger };
    const request = mock.fn(async (endpoint: string, options: Record<string, unknown>) => {
        if (endpoint.startsWith('GET ')) {
            if (!runningNewerTransition && !startedNewerTransition && labels.has('llm-codex-gpt56-sol')) {
                startedNewerTransition = true;
                runningNewerTransition = true;
                newerPromise = safeUpdateLabels(context, [], [], {
                    targetLabel: 'llm-gemini-3-pro',
                    isManagedLabel: label => label.startsWith('llm-'),
                    maxAttempts: 1,
                    redis: redis as never,
                }).then(result => {
                    newerResult = result;
                    runningNewerTransition = false;
                    return result;
                });
                await Promise.resolve();
                throw new Error('older transition verification failed');
            }
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
    context.octokit.request = request as never;

    const olderResult = await safeUpdateLabels(context, [], [], {
        targetLabel: 'llm-codex-gpt56-sol',
        isManagedLabel: label => label.startsWith('llm-'),
        maxAttempts: 1,
        redis: redis as never,
    });
    await newerPromise;

    assert.strictEqual(newerResult?.success, true);
    assert.strictEqual(olderResult.success, false);
    assert.deepStrictEqual([...labels].sort(), ['AI', 'llm-gemini-3-pro']);
    assert.deepStrictEqual(olderResult.finalLabels?.sort(), ['AI', 'llm-claude-opus48']);
});

test('serializes a newer transition started after rollback ownership read and before restoration mutations', async () => {
    const labels = new Set(['AI', 'llm-claude-opus48']);
    const redis = createTransitionRedis();
    let issueReads = 0;
    let newerPromise: Promise<Awaited<ReturnType<typeof safeUpdateLabels>>> | undefined;
    let newerResult: Awaited<ReturnType<typeof safeUpdateLabels>> | undefined;
    let newerSucceededBeforeRestorationMutation = false;
    const transitionOrder: string[] = [];
    const context = { octokit: { request: undefined as never }, owner: 'integry', repo: 'propr', issueNumber: 42, logger };
    const request = mock.fn(async (endpoint: string, options: Record<string, unknown>) => {
        if (endpoint.startsWith('GET ')) {
            issueReads += 1;
            if (issueReads === 2) throw new Error('older transition verification failed');
            const snapshot = [...labels];
            if (issueReads === 3) {
                transitionOrder.push('A-rollback-ownership-read');
                newerPromise = safeUpdateLabels(context, [], [], {
                    targetLabel: 'llm-gemini-3-pro',
                    isManagedLabel: label => label.startsWith('llm-'),
                    maxAttempts: 1,
                    redis: redis as never,
                }).then(result => {
                    newerResult = result;
                    transitionOrder.push('B-success');
                    return result;
                });
                transitionOrder.push('B-started');
                await Promise.resolve();
            }
            return { data: { labels: snapshot } };
        }
        if (endpoint.startsWith('POST ')) {
            const label = (options.labels as string[])[0];
            if (label === 'llm-claude-opus48') {
                newerSucceededBeforeRestorationMutation = newerResult?.success === true;
                transitionOrder.push('A-restoration-mutation');
            }
            labels.add(label);
            return {};
        }
        if (endpoint.startsWith('DELETE ')) {
            labels.delete(options.name as string);
            return {};
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    context.octokit.request = request as never;

    const olderResult = await safeUpdateLabels(context, [], [], {
        targetLabel: 'llm-codex-gpt56-sol',
        isManagedLabel: label => label.startsWith('llm-'),
        maxAttempts: 1,
        redis: redis as never,
    });
    transitionOrder.push('A-complete');
    await newerPromise;

    assert.strictEqual(newerSucceededBeforeRestorationMutation, false);
    assert.strictEqual(olderResult.success, false);
    assert.strictEqual(newerResult?.success, true);
    assert.deepStrictEqual(olderResult.finalLabels?.sort(), ['AI', 'llm-claude-opus48']);
    assert.deepStrictEqual([...labels].sort(), ['AI', 'llm-gemini-3-pro']);
    assert.deepStrictEqual(transitionOrder, [
        'A-rollback-ownership-read',
        'B-started',
        'A-restoration-mutation',
        'A-complete',
        'B-success',
    ]);
});

test('lease loss during convergence fences all later managed-label mutations', async () => {
    const labels = new Set(['AI', 'llm-claude-opus48']);
    const mutations: string[] = [];
    let leaseOwned = true;
    const lease = {
        identity: { owner: 'integry', repo: 'propr', pr: 42 },
        assertOwned: async () => {
            if (!leaseOwned) throw new Error('lease lost during label mutation');
        },
    };
    const request = mock.fn(async (endpoint: string, options: Record<string, unknown>) => {
        if (endpoint.startsWith('GET ')) return { data: { labels: [...labels] } };
        mutations.push(`${endpoint}:${String((options.labels as string[] | undefined)?.[0] ?? options.name)}`);
        if (endpoint.startsWith('POST ')) {
            labels.add((options.labels as string[])[0]);
            // The lease expires while the add is in flight and a newer owner
            // establishes its selection before the stale request returns.
            leaseOwned = false;
            labels.clear();
            labels.add('AI');
            labels.add('llm-gemini-3-pro');
            return {};
        }
        if (endpoint.startsWith('DELETE ')) labels.delete(options.name as string);
        return {};
    });

    const result = await safeUpdateLabels(
        { octokit: { request }, owner: 'integry', repo: 'propr', issueNumber: 42, logger },
        [], [],
        {
            targetLabel: 'llm-codex-gpt56-sol',
            isManagedLabel: label => label.startsWith('llm-'),
            redis: createTransitionRedis() as never,
            lease,
        },
    );

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(mutations, [
        'POST /repos/{owner}/{repo}/issues/{issue_number}/labels:llm-codex-gpt56-sol',
    ]);
    assert.deepStrictEqual([...labels].sort(), ['AI', 'llm-gemini-3-pro']);
});

test('lease loss during restoration cannot continue by deleting a newer selection', async () => {
    const labels = new Set(['AI', 'llm-claude-opus48']);
    const mutations: string[] = [];
    let leaseOwned = true;
    const lease = {
        identity: { owner: 'integry', repo: 'propr', pr: 42 },
        assertOwned: async () => {
            if (!leaseOwned) throw new Error('lease lost during restoration mutation');
        },
    };
    const request = mock.fn(async (endpoint: string, options: Record<string, unknown>) => {
        if (endpoint.startsWith('GET ')) return { data: { labels: [...labels] } };
        const label = String((options.labels as string[] | undefined)?.[0] ?? options.name);
        mutations.push(`${endpoint}:${label}`);
        if (endpoint.startsWith('POST ')) {
            labels.add(label);
            if (label === 'llm-claude-opus48') {
                leaseOwned = false;
                labels.clear();
                labels.add('AI');
                labels.add('llm-claude-opus48');
                labels.add('llm-gemini-3-pro');
            }
            return {};
        }
        labels.delete(label);
        if (label === 'llm-claude-opus48') labels.delete('llm-codex-gpt56-sol');
        return {};
    });

    const result = await safeUpdateLabels(
        { octokit: { request }, owner: 'integry', repo: 'propr', issueNumber: 42, logger },
        [], [],
        {
            targetLabel: 'llm-codex-gpt56-sol',
            isManagedLabel: label => label.startsWith('llm-'),
            maxAttempts: 1,
            redis: createTransitionRedis() as never,
            lease,
        },
    );

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(mutations, [
        'POST /repos/{owner}/{repo}/issues/{issue_number}/labels:llm-codex-gpt56-sol',
        'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}:llm-claude-opus48',
        'POST /repos/{owner}/{repo}/issues/{issue_number}/labels:llm-claude-opus48',
    ]);
    assert.deepStrictEqual([...labels].sort(), ['AI', 'llm-claude-opus48', 'llm-gemini-3-pro']);
});

test('exclusive transition leases do not serialize unrelated PRs', async () => {
    const redis = createTransitionRedis();
    let releaseFirstMutation!: () => void;
    let firstMutationStarted!: () => void;
    const firstMutationGate = new Promise<void>(resolve => { releaseFirstMutation = resolve; });
    const firstMutationStart = new Promise<void>(resolve => { firstMutationStarted = resolve; });
    const firstLabels = new Set(['llm-claude-opus48']);
    const secondLabels = new Set(['llm-claude-opus48']);
    const createRequest = (labels: Set<string>, blockMutation: boolean) => mock.fn(async (endpoint: string, options: Record<string, unknown>) => {
        if (endpoint.startsWith('GET ')) return { data: { labels: [...labels] } };
        if (endpoint.startsWith('POST ')) {
            labels.add((options.labels as string[])[0]);
            if (blockMutation) {
                firstMutationStarted();
                await firstMutationGate;
            }
            return {};
        }
        if (endpoint.startsWith('DELETE ')) {
            labels.delete(options.name as string);
            return {};
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    const first = safeUpdateLabels(
        { octokit: { request: createRequest(firstLabels, true) }, owner: 'integry', repo: 'propr', issueNumber: 42, logger },
        [], [],
        { targetLabel: 'llm-codex-gpt56-sol', isManagedLabel: label => label.startsWith('llm-'), redis: redis as never },
    );
    await firstMutationStart;
    const second = safeUpdateLabels(
        { octokit: { request: createRequest(secondLabels, false) }, owner: 'integry', repo: 'propr', issueNumber: 43, logger },
        [], [],
        { targetLabel: 'llm-gemini-3-pro', isManagedLabel: label => label.startsWith('llm-'), redis: redis as never },
    );
    const secondWhileFirstHeld = await Promise.race([
        second,
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 50)),
    ]);
    releaseFirstMutation();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.strictEqual(secondWhileFirstHeld?.success, true);
    assert.strictEqual(firstResult.success, true);
    assert.strictEqual(secondResult.success, true);
});
