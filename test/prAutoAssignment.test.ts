import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Automatic assignment of an implementation's pull request when it reaches
 * the done label: policy, target resolution, additive assignment, review
 * requests, idempotency and failure isolation.
 */

type Policy = { enabled: boolean; defaultAssignee: string | null; requestReview: boolean };
type Subject = { owner: string; repo: string; number: number; kind: string };

let policy: Policy = { enabled: false, defaultAssignee: null, requestReview: false };
const resolveRepositoryAutoAssignment = mock.fn(async (_owner: string, _repo: string) => ({ ...policy }));

// Mirrors `setTaskAssignees` in `add` mode: one POST through the given client,
// answered with the confirmed assignee set.
const setTaskAssignees = mock.fn(async (_taskId: string, logins: string[], options: { mode: string; subject?: Subject; github: { request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }> } }) => {
    assert.equal(options.mode, 'add');
    const subject = options.subject!;
    const response = await options.github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/assignees', {
        owner: subject.owner, repo: subject.repo, issue_number: subject.number, assignees: logins,
    });
    const confirmed = (response.data as { assignees: Array<{ login: string }> }).assignees.map(user => user.login);
    return {
        subject,
        assignees: confirmed.map(login => ({ id: login, login, displayName: null, avatarUrl: null })),
        rejected: logins.filter(login => !confirmed.includes(login)).map(login => ({ id: login, login, displayName: null, avatarUrl: null })),
    };
});

// Mirrors `refreshTaskAssignees`: re-reads the subject and stores its assignees.
const refreshTaskAssignees = mock.fn(async (_taskId: string, subject: Subject, options: { github: { request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }> } }) => {
    await options.github.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner: subject.owner, repo: subject.repo, issue_number: subject.number });
    return [];
});

await mock.module('@propr/core', {
    namedExports: {
        refreshTaskAssignees,
        resolveRepositoryAutoAssignment,
        setTaskAssignees,
        TaskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', POST_PROCESSING: 'post_processing' },
    },
});

const {
    autoAssignImplementationPullRequest,
    autoAssignmentClaimKey,
    autoAssignmentLeaseKey,
    recordAutoAssignmentEvent,
    PR_AUTO_ASSIGNMENT_EVENT,
} = await import('../src/github/prAutoAssignment.ts');

// ========== Fake GitHub and Redis ==========

const BOT = 'propr-dev[bot]';

const github = {
    issueAuthor: 'alice' as string | null,
    prAuthor: BOT,
    headSha: 'abc123',
    assignees: [] as string[],
    requestedReviewers: [] as string[],
    noAccess: new Set<string>(),
    failAssign: false,
    failReview: false,
    calls: [] as Array<{ route: string; parameters: Record<string, unknown> }>,
};

async function request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }> {
    github.calls.push({ route, parameters });
    switch (route) {
        case 'GET /repos/{owner}/{repo}/issues/{issue_number}':
            return { data: { user: github.issueAuthor ? { login: github.issueAuthor } : null } };
        case 'GET /repos/{owner}/{repo}/pulls/{pull_number}':
            return { data: { head: { sha: github.headSha }, user: { login: github.prAuthor }, assignees: github.assignees.map(login => ({ login })) } };
        case 'POST /repos/{owner}/{repo}/issues/{issue_number}/assignees': {
            if (github.failAssign) throw Object.assign(new Error('GitHub is down'), { status: 502 });
            for (const login of parameters.assignees as string[]) {
                if (!github.noAccess.has(login) && !github.assignees.includes(login)) github.assignees.push(login);
            }
            return { data: { assignees: github.assignees.map(login => ({ login })) } };
        }
        case 'GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers':
            return { data: { users: github.requestedReviewers.map(login => ({ login })), teams: [] } };
        case 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers':
            if (github.failReview) throw Object.assign(new Error('Review request refused'), { status: 422 });
            github.requestedReviewers.push(...(parameters.reviewers as string[]));
            return { data: {} };
        default:
            throw new Error(`Unexpected GitHub route ${route}`);
    }
}

const octokit = { request: request as <T = unknown>(route: string, parameters: Record<string, unknown>) => Promise<T> };

const redisKeys = new Map<string, string>();
const redisTtls = new Map<string, number>();
const redis = {
    failing: false,
    async get(key: string) {
        if (this.failing) throw new Error('Redis unavailable');
        return redisKeys.get(key) ?? null;
    },
    async set(key: string, value: string, _mode: 'EX', seconds: number, condition?: 'NX') {
        if (this.failing) throw new Error('Redis unavailable');
        if (condition === 'NX' && redisKeys.has(key)) return null;
        redisKeys.set(key, value);
        redisTtls.set(key, seconds);
        return 'OK';
    },
    async del(key: string) {
        redisKeys.delete(key);
        return 1;
    },
};

const logs: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
const logger = {
    info: (fields: Record<string, unknown>, message: string) => { logs.push({ level: 'info', fields, message }); },
    warn: (fields: Record<string, unknown>, message: string) => { logs.push({ level: 'warn', fields, message }); },
};

function writes(): string[] {
    return github.calls.filter(call => !call.route.startsWith('GET ')).map(call => call.route);
}

function run(overrides: Record<string, unknown> = {}) {
    return autoAssignImplementationPullRequest({
        owner: 'integry', repo: 'propr', issueNumber: 12, prNumber: 34, taskId: 'task-1',
        issueAuthor: undefined, octokit, redis, logger: logger as never,
        ...overrides,
    });
}

beforeEach(() => {
    policy = { enabled: true, defaultAssignee: null, requestReview: false };
    Object.assign(github, {
        issueAuthor: 'alice', prAuthor: BOT, headSha: 'abc123', assignees: [], requestedReviewers: [],
        noAccess: new Set<string>(), failAssign: false, failReview: false, calls: [],
    });
    redis.failing = false;
    redisKeys.clear();
    redisTtls.clear();
    logs.length = 0;
    setTaskAssignees.mock.resetCalls();
    refreshTaskAssignees.mock.resetCalls();
});

describe('autoAssignImplementationPullRequest', () => {
    test('does nothing on GitHub when the repository option is off (the default)', async () => {
        policy = { enabled: false, defaultAssignee: null, requestReview: true };
        const outcome = await run();
        assert.equal(outcome.status, 'disabled');
        assert.deepEqual(github.calls, []);
        assert.equal(redisKeys.size, 0);
        assert.equal(setTaskAssignees.mock.callCount(), 0);
    });

    test('assigns the pull request to the source issue author', async () => {
        const outcome = await run();
        assert.deepEqual(outcome, { status: 'assigned', reason: 'assigned alice', assignee: 'alice', opportunity: 'implementation_done' });
        assert.deepEqual(github.assignees, ['alice']);
        const [taskId, logins, options] = setTaskAssignees.mock.calls[0].arguments;
        assert.equal(taskId, 'task-1');
        assert.deepEqual(logins, ['alice']);
        assert.deepEqual(options.subject, { owner: 'integry', repo: 'propr', number: 34, kind: 'pull_request' });
        assert.ok(logs.some(log => log.level === 'info' && log.fields.status === 'assigned'));
    });

    test('uses the already-read issue author without reading the issue again', async () => {
        await run({ issueAuthor: 'carol' });
        assert.deepEqual(github.assignees, ['carol']);
        assert.ok(!github.calls.some(call => call.route === 'GET /repos/{owner}/{repo}/issues/{issue_number}'));
    });

    test('assigns the configured default assignee instead of the issue author', async () => {
        policy.defaultAssignee = 'octocat';
        const outcome = await run();
        assert.equal(outcome.assignee, 'octocat');
        assert.deepEqual(github.assignees, ['octocat']);
    });

    test('skips a bot issue author and logs why', async () => {
        github.issueAuthor = BOT;
        const outcome = await run();
        assert.equal(outcome.status, 'skipped');
        assert.match(outcome.reason, /is a bot/);
        assert.deepEqual(writes(), []);
        assert.ok(logs.some(log => log.level === 'info' && /is a bot/.test(String(log.fields.reason))));
    });

    test('still assigns the default assignee when the issue author is a bot', async () => {
        github.issueAuthor = BOT;
        policy.defaultAssignee = 'octocat';
        const outcome = await run();
        assert.equal(outcome.status, 'assigned');
        assert.deepEqual(github.assignees, ['octocat']);
    });

    test('keeps assignees a human added manually', async () => {
        github.assignees = ['bob'];
        await run();
        assert.deepEqual(github.assignees, ['bob', 'alice']);
    });

    test('does not write again when the target is already assigned on GitHub', async () => {
        github.assignees = ['Alice'];
        const outcome = await run();
        assert.equal(outcome.status, 'already_assigned');
        assert.deepEqual(writes(), []);
    });

    test('refreshes the task\'s stored assignees from the pull request when the target is already assigned', async () => {
        github.assignees = ['alice'];
        const outcome = await run();
        assert.equal(outcome.status, 'already_assigned');
        assert.equal(setTaskAssignees.mock.callCount(), 0);
        const [taskId, subject] = refreshTaskAssignees.mock.calls[0].arguments;
        assert.equal(taskId, 'task-1');
        assert.deepEqual(subject, { owner: 'integry', repo: 'propr', number: 34, kind: 'pull_request' });
    });

    test('a retry after GitHub assigned but storing the result failed repairs the stored assignees', async () => {
        // GitHub accepts the assignee, then persisting the confirmed set fails.
        const assign = mock.fn(async (taskId: string, logins: string[], options: never) => {
            await setTaskAssignees(taskId, logins, options);
            throw new Error('database unavailable');
        });
        const first = await run({ assign });
        assert.equal(first.status, 'failed');
        assert.deepEqual(github.assignees, ['alice']);
        assert.equal(redisKeys.size, 0);

        const retry = await run();
        assert.equal(retry.status, 'already_assigned');
        assert.equal(refreshTaskAssignees.mock.callCount(), 1);
        assert.ok(redisKeys.has(autoAssignmentClaimKey('integry', 'propr', 34, 'abc123')));
    });

    test('a failed refresh of the stored assignees stays retryable', async () => {
        github.assignees = ['alice'];
        refreshTaskAssignees.mock.mockImplementationOnce(async () => { throw new Error('database unavailable'); });
        const outcome = await run();
        assert.equal(outcome.status, 'failed');
        assert.match(outcome.reason, /database unavailable/);
        assert.equal(redisKeys.size, 0);

        assert.equal((await run()).status, 'already_assigned');
        assert.equal(refreshTaskAssignees.mock.callCount(), 2);
        assert.ok(redisKeys.has(autoAssignmentClaimKey('integry', 'propr', 34, 'abc123')));
    });

    test('records completion only after the assignment succeeds, under a short in-progress lease', async () => {
        const completedKey = autoAssignmentClaimKey('integry', 'propr', 34, 'abc123');
        const leaseKey = autoAssignmentLeaseKey('integry', 'propr', 34, 'abc123');
        const assign = mock.fn(async (taskId: string, logins: string[], options: never) => {
            assert.ok(redisKeys.has(leaseKey));
            assert.ok(!redisKeys.has(completedKey));
            return await setTaskAssignees(taskId, logins, options);
        });
        assert.equal((await run({ assign })).status, 'assigned');
        assert.equal(assign.mock.callCount(), 1);
        assert.ok(redisKeys.has(completedKey));
        assert.ok(!redisKeys.has(leaseKey));
        assert.ok(redisTtls.get(leaseKey)! <= 15 * 60);
        assert.ok(redisTtls.get(completedKey)! > redisTtls.get(leaseKey)!);
    });

    test('an attempt interrupted before assigning does not suppress the retry once its lease expires', async () => {
        // A worker died after taking the lease and before any GitHub write.
        const leaseKey = autoAssignmentLeaseKey('integry', 'propr', 34, 'abc123');
        redisKeys.set(leaseKey, new Date().toISOString());

        const whileLeased = await run();
        assert.equal(whileLeased.status, 'skipped');
        assert.match(whileLeased.reason, /in progress/);
        assert.deepEqual(writes(), []);

        redisKeys.delete(leaseKey); // the lease TTL elapses
        const retry = await run();
        assert.equal(retry.status, 'assigned');
        assert.deepEqual(github.assignees, ['alice']);
    });

    test('a second pass for the same pull request and head performs no GitHub writes', async () => {
        policy.requestReview = true;
        await run();
        const firstWrites = writes().length;
        assert.equal(firstWrites, 2);
        // The reviewer has since reviewed, so GitHub no longer lists the request.
        github.requestedReviewers = [];

        const outcome = await run();
        assert.equal(outcome.status, 'already_assigned');
        assert.match(outcome.reason, /already handled for head abc123/);
        assert.equal(writes().length, firstWrites);
        assert.ok(logs.some(log => /already assigned/.test(log.message)));
        assert.ok(redisKeys.has(autoAssignmentClaimKey('integry', 'propr', 34, 'abc123')));
    });

    test('a new head after a follow-up is a new opportunity', async () => {
        await run();
        github.headSha = 'def456';
        github.assignees = [];
        const outcome = await run();
        assert.equal(outcome.status, 'assigned');
    });

    test('requests a review from the assignee when configured', async () => {
        policy.requestReview = true;
        const outcome = await run();
        assert.deepEqual(outcome.review, { status: 'requested', reason: 'requested a review from alice' });
        assert.deepEqual(github.requestedReviewers, ['alice']);
        const post = github.calls.find(call => call.route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers');
        assert.deepEqual(post?.parameters.reviewers, ['alice']);
    });

    test('does not duplicate an already pending review request', async () => {
        policy.requestReview = true;
        github.requestedReviewers = ['ALICE'];
        const outcome = await run();
        assert.equal(outcome.review?.status, 'skipped');
        assert.match(outcome.review!.reason, /already requested/);
        assert.deepEqual(github.requestedReviewers, ['ALICE']);
    });

    test('never requests a review from the pull request author', async () => {
        policy.requestReview = true;
        policy.defaultAssignee = 'alice';
        github.prAuthor = 'alice';
        const outcome = await run();
        assert.equal(outcome.status, 'assigned');
        assert.equal(outcome.review?.status, 'skipped');
        assert.match(outcome.review!.reason, /authored the pull request/);
        assert.ok(!github.calls.some(call => call.route.includes('requested_reviewers')));
    });

    test('a failed assignment is reported, not thrown, and can be retried', async () => {
        github.failAssign = true;
        const outcome = await run();
        assert.equal(outcome.status, 'failed');
        assert.match(outcome.reason, /GitHub is down/);
        assert.ok(logs.some(log => log.level === 'warn'));
        assert.equal(redisKeys.size, 0);

        github.failAssign = false;
        assert.equal((await run()).status, 'assigned');
    });

    test('a failed review request keeps the assignment and releases the claim', async () => {
        policy.requestReview = true;
        github.failReview = true;
        const outcome = await run();
        assert.equal(outcome.status, 'assigned');
        assert.equal(outcome.review?.status, 'failed');
        assert.deepEqual(github.assignees, ['alice']);
        assert.equal(redisKeys.size, 0);
    });

    test('a policy read failure is reported, not thrown', async () => {
        resolveRepositoryAutoAssignment.mock.mockImplementationOnce(async () => { throw new Error('config unavailable'); });
        const outcome = await run();
        assert.equal(outcome.status, 'failed');
        assert.deepEqual(github.calls, []);
    });

    test('reports a user GitHub would not assign and skips the review request', async () => {
        policy.requestReview = true;
        github.noAccess.add('alice');
        const outcome = await run();
        assert.equal(outcome.status, 'not_assigned');
        assert.equal(outcome.review, undefined);
        assert.equal(redisKeys.size, 0);
    });

    test('continues without the idempotency key when Redis is unavailable', async () => {
        redis.failing = true;
        const outcome = await run();
        assert.equal(outcome.status, 'assigned');
    });
});

describe('recordAutoAssignmentEvent', () => {
    function stateManager(state: string | null) {
        return {
            getTaskState: mock.fn(async () => (state ? { state } : null)),
            updateTaskState: mock.fn(async (_taskId: string, _state: string, _metadata: Record<string, unknown>) => ({})),
        };
    }

    test('records the outcome on the task timeline in the current state', async () => {
        const manager = stateManager('post_processing');
        await recordAutoAssignmentEvent({ stateManager: manager as never, taskId: 'task-1', prNumber: 34, outcome: { status: 'assigned', reason: 'assigned alice', assignee: 'alice' } });
        const [taskId, state, metadata] = manager.updateTaskState.mock.calls[0].arguments;
        assert.equal(taskId, 'task-1');
        assert.equal(state, 'post_processing');
        assert.equal(metadata.reason, 'Assigned pull request to alice');
        assert.deepEqual(metadata.historyMetadata, {
            event: PR_AUTO_ASSIGNMENT_EVENT,
            autoAssignment: { status: 'assigned', reason: 'assigned alice', assignee: 'alice', prNumber: 34 },
            description: 'Assigned pull request to alice',
        });
    });

    test('records nothing for a disabled repository or a finished task', async () => {
        const manager = stateManager('post_processing');
        await recordAutoAssignmentEvent({ stateManager: manager as never, taskId: 'task-1', prNumber: 34, outcome: { status: 'disabled', reason: 'disabled for the repository' } });
        assert.equal(manager.getTaskState.mock.callCount(), 0);

        const finished = stateManager('completed');
        await recordAutoAssignmentEvent({ stateManager: finished as never, taskId: 'task-1', prNumber: 34, outcome: { status: 'assigned', reason: 'assigned alice', assignee: 'alice' } });
        assert.equal(finished.updateTaskState.mock.callCount(), 0);
    });

    test('a timeline write failure is logged, not thrown', async () => {
        const manager = stateManager('post_processing');
        manager.updateTaskState.mock.mockImplementation(async () => { throw new Error('db down'); });
        const warnings: string[] = [];
        await recordAutoAssignmentEvent({
            stateManager: manager as never, taskId: 'task-1', prNumber: 34, outcome: { status: 'skipped', reason: 'no author' },
            logger: { warn: (_fields: unknown, message: string) => { warnings.push(message); } } as never,
        });
        assert.equal(warnings.length, 1);
    });
});
