import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Re-assignment when follow-up work completes: `handlePostExecution` with the
 * real auto-assignment code against a fake GitHub. Covers the commit and
 * no-commit cases, `/review`, continuation pull requests, per-commit
 * idempotency, review-request deduplication across the implementation and
 * follow-up opportunities, manual assignees, failure isolation and the task
 * timeline entry.
 */

type Policy = { enabled: boolean; defaultAssignee: string | null; requestReview: boolean };
type Subject = { owner: string; repo: string; number: number; kind: string };
type GitHubRequest = (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;

let policy: Policy = { enabled: false, defaultAssignee: null, requestReview: false };
let policyError: Error | null = null;
const resolveRepositoryAutoAssignment = mock.fn(async (_owner: string, _repo: string) => {
    if (policyError) throw policyError;
    return { ...policy };
});

// Mirrors `setTaskAssignees` in `add` mode: one POST through the given client.
const setTaskAssignees = mock.fn(async (_taskId: string, logins: string[], options: { mode: string; subject?: Subject; github: { request: GitHubRequest } }) => {
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
const refreshTaskAssignees = mock.fn(async () => []);

// Each test sets the commit the follow-up produces; null means no changes.
let nextCommit: { commitHash: string; filesChanged: string[] } | null = null;
const noOp = async () => undefined;

await mock.module('@propr/core', {
    namedExports: {
        refreshTaskAssignees,
        resolveRepositoryAutoAssignment,
        setTaskAssignees,
        commitChanges: async () => (nextCommit ? { ...nextCommit } : null),
        cleanupPreparedVisualPreviewEvidence: noOp,
        prepareVisualPreviewEvidence: async () => ({ evidence: { assets: [], toolSuggestions: [] } }),
        loadRepositoryVisualPreviewSettings: async () => ({ enabled: false, types: [] }),
        appendVisualPreviewSection: (body: string) => body,
        renderVisualPreviewSection: () => '',
        renderVisualPreviewUploadFailureSection: () => '',
        resolveAgentTerminationReason: () => undefined,
        describeAgentTermination: () => '',
        sanitizeAgentReport: (value: string | null | undefined) => value ?? '',
        getAuthenticatedOctokit: noOp,
        db: () => ({ where: () => ({ update: async () => 1 }) }),
        TaskStates: { PROCESSING: 'processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
        VISUAL_PREVIEW_SLOT: '<!-- slot -->',
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
    },
});
for (const [name, namedExports] of Object.entries({
    prCompletionComment: { buildCompletionComment: async () => 'Follow-up done' },
    prCommentJobUtils: { buildCommitMessage: () => 'commit' },
    reviewCommentGatherer: { markReviewFindingsProcessed: noOp },
    reviewFindingSelector: { selectedReviewFeedbackIds: () => ({ findingIds: [], suggestionIds: [] }) },
    ultrafixJobHelpers: { resolveUltrafixHistoryMeta: async () => ({}) },
    prContinuation: { savePublicationCheckpoint: noOp },
    pushSalvageTimeline: { recordPushSalvageEvent: () => noOp },
    notificationRecap: { buildWorkNotificationRecap: () => '' },
})) {
    await mock.module(`../src/jobs/${name}.js`, { namedExports });
}
await mock.module('../src/github/visualPreviewAttachments.js', {
    namedExports: { isVisualPreviewUploadAuthenticationError: () => false, publishPullRequestCommentVisualPreviews: noOp },
});

const { handlePostExecution } = await import('../src/jobs/prCommentPostExecution.ts');
const { autoAssignImplementationPullRequest, PR_AUTO_ASSIGNMENT_EVENT } = await import('../src/github/prAutoAssignment.ts');

// ========== Fake GitHub, Redis and task state ==========

const BOT = 'propr-dev[bot]';
const ORIGINAL_PR = 34;
const CONTINUATION_PR = 100;

interface FakePullRequest { head: string; body: string; assignees: string[]; requestedReviewers: string[] }

const github = {
    issueAuthors: new Map<number, string>(),
    /** Authors of issues in repositories other than integry/propr, keyed `owner/repo#n`. */
    foreignIssueAuthors: new Map<string, string>(),
    pulls: new Map<number, FakePullRequest>(),
    failAssign: false,
    calls: [] as Array<{ route: string; parameters: Record<string, unknown> }>,
};

function pull(number: number): FakePullRequest {
    const found = github.pulls.get(number);
    if (!found) throw Object.assign(new Error(`No pull request #${number}`), { status: 404 });
    return found;
}

async function request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }> {
    github.calls.push({ route, parameters });
    switch (route) {
        case 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}':
            return { data: { id: parameters.comment_id, html_url: `https://github.com/integry/propr/pull/${ORIGINAL_PR}#issuecomment-1`, body: parameters.body } };
        case 'GET /repos/{owner}/{repo}/issues/{issue_number}': {
            const local = parameters.owner === 'integry' && parameters.repo === 'propr';
            const author = local ? github.issueAuthors.get(parameters.issue_number as number)
                : github.foreignIssueAuthors.get(`${parameters.owner}/${parameters.repo}#${parameters.issue_number}`);
            return { data: { user: author ? { login: author } : null } };
        }
        case 'GET /repos/{owner}/{repo}/pulls/{pull_number}': {
            const found = pull(parameters.pull_number as number);
            return { data: { head: { sha: found.head }, body: found.body, user: { login: BOT }, assignees: found.assignees.map(login => ({ login })) } };
        }
        case 'POST /repos/{owner}/{repo}/issues/{issue_number}/assignees': {
            if (github.failAssign) throw Object.assign(new Error('GitHub is down'), { status: 502 });
            const found = pull(parameters.issue_number as number);
            for (const login of parameters.assignees as string[]) if (!found.assignees.includes(login)) found.assignees.push(login);
            return { data: { assignees: found.assignees.map(login => ({ login })) } };
        }
        case 'GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers':
            return { data: { users: pull(parameters.pull_number as number).requestedReviewers.map(login => ({ login })), teams: [] } };
        case 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers':
            pull(parameters.pull_number as number).requestedReviewers.push(...(parameters.reviewers as string[]));
            return { data: {} };
        default:
            throw new Error(`Unexpected GitHub route ${route}`);
    }
}

const octokit = { request: request as <T = unknown>(route: string, parameters: Record<string, unknown>) => Promise<T> };

const redisKeys = new Map<string, string>();
const redisClient = {
    async get(key: string) { return redisKeys.get(key) ?? null; },
    async set(key: string, value: string, _mode: 'EX', _seconds: number, condition?: 'NX') {
        if (condition === 'NX' && redisKeys.has(key)) return null;
        redisKeys.set(key, value);
        return 'OK';
    },
    async del(key: string) { redisKeys.delete(key); return 1; },
};

const logs: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
const logger = {
    debug: () => undefined, error: () => undefined,
    info: (fields: Record<string, unknown>, message: string) => { logs.push({ level: 'info', fields, message }); },
    warn: (fields: Record<string, unknown>, message: string) => { logs.push({ level: 'warn', fields, message }); },
};

const TASK_ID = 'task-followup';
const taskStates = new Map<string, string>();
const history: Array<{ state: string; metadata: { reason?: string; commitHash?: string; historyMetadata?: Record<string, unknown> } }> = [];
const stateManager = {
    async getTaskState(taskId: string) { return taskStates.has(taskId) ? { state: taskStates.get(taskId)! } : null; },
    async updateTaskState(taskId: string, state: string, metadata: { reason?: string; historyMetadata?: Record<string, unknown> } = {}) {
        taskStates.set(taskId, state);
        history.push({ state, metadata });
        return { state };
    },
};

function assignmentWrites(): Array<{ route: string; parameters: Record<string, unknown> }> {
    return github.calls.filter(call => call.route.startsWith('POST') && (call.route.endsWith('/assignees') || call.route.endsWith('/requested_reviewers')));
}

function assignmentEvents() {
    return history.filter(entry => entry.metadata.historyMetadata?.event === PR_AUTO_ASSIGNMENT_EVENT);
}

interface FollowUpOptions {
    commit?: string | null;
    commandMode?: string;
    continuationPr?: number;
    linkedIssue?: { owner: string; repo: string; number: number } | null;
    /** Completes a recovered publication from this checkpoint instead of committing. */
    recoveredCompletion?: Record<string, unknown>;
}

/** The completion inputs the last push checkpointed. */
let pushedCompletion: Record<string, unknown> | undefined;

/** Runs one follow-up's post-execution: commit, push, completion comment, terminal state. */
async function runFollowUp(options: FollowUpOptions = {}) {
    const commit = options.commit === undefined ? 'c'.repeat(40) : options.commit;
    nextCommit = commit ? { commitHash: commit, filesChanged: ['src/index.ts'] } : null;
    taskStates.set(TASK_ID, 'claude_execution');
    const target = options.continuationPr ?? ORIGINAL_PR;
    const publication = {
        status: '',
        continuation: options.continuationPr ? { continuation_pr: options.continuationPr } : undefined,
        pendingCompletion: undefined,
        push: async (_worktreePath: string, completion: Record<string, unknown>) => {
            pushedCompletion = completion;
            // The pushed commit becomes the head of the pull request that received it.
            if (commit) pull(target).head = commit;
            return { commitHash: commit };
        },
    };
    return handlePostExecution({
        state: {
            octokit, worktreeInfo: { worktreePath: '/worktree', branchName: 'feature' }, authorsText: '@commenter',
            unprocessedComments: [{ id: 501, body: 'Please also handle the empty case', author: 'commenter' }],
            claudeResult: { success: true, summary: 'Handled the empty case' },
            startingWorkComment: { data: { id: 900, html_url: '' } },
        },
        job: { data: { commandMode: options.commandMode ?? 'default' } },
        taskId: TASK_ID, stateManager,
        context: { pullRequestNumber: ORIGINAL_PR, repoOwner: 'integry', repoName: 'propr', publication, correlatedLogger: logger },
        unprocessedReviewComments: [], llm: null, redisClient, prProcessingLockKey: 'lock', prProcessingLockToken: 'token',
        linkedIssue: options.linkedIssue,
        recoveredCompletion: options.recoveredCompletion && {
            commitResult: nextCommit, changesSummary: 'Handled the empty case', commitMessage: 'commit', ...options.recoveredCompletion,
        },
    } as never, 'https://propr.test/tasks/task-followup');
}

beforeEach(() => {
    policy = { enabled: true, defaultAssignee: null, requestReview: false };
    policyError = null;
    github.issueAuthors = new Map([[12, 'alice'], [77, 'dana']]);
    github.foreignIssueAuthors = new Map([['acme/tracker#77', 'erin']]);
    pushedCompletion = undefined;
    github.pulls = new Map([
        [ORIGINAL_PR, { head: 'a'.repeat(40), body: 'Implements the feature.\n\nCloses #12', assignees: [], requestedReviewers: [] }],
        [CONTINUATION_PR, { head: 'd'.repeat(40), body: 'Continuation of #34.\n\nCloses #12', assignees: [], requestedReviewers: [] }],
    ]);
    github.failAssign = false;
    github.calls = [];
    redisKeys.clear();
    logs.length = 0;
    taskStates.clear();
    history.length = 0;
    nextCommit = null;
    resolveRepositoryAutoAssignment.mock.resetCalls();
    setTaskAssignees.mock.resetCalls();
    refreshTaskAssignees.mock.resetCalls();
});

describe('re-assignment after follow-up work', () => {
    test('with the repository option off nothing is assigned and the follow-up is unchanged', async () => {
        policy = { enabled: false, defaultAssignee: 'carol', requestReview: true };
        const result = await runFollowUp();
        assert.equal(result.commitHash, 'c'.repeat(40));
        assert.deepEqual(github.calls.map(call => call.route), ['PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}']);
        assert.deepEqual(assignmentEvents(), []);
        assert.equal(taskStates.get(TASK_ID), 'completed');
    });

    test('a follow-up that pushed a commit re-assigns the linked source issue\'s author, not the commenter', async () => {
        await runFollowUp();
        assert.deepEqual(pull(ORIGINAL_PR).assignees, ['alice']);
        // The issue was found through the pull request body's `Closes #12`.
        assert.ok(github.calls.some(call => call.route === 'GET /repos/{owner}/{repo}/issues/{issue_number}' && call.parameters.issue_number === 12));
        assert.ok(!pull(ORIGINAL_PR).assignees.includes('commenter'));
    });

    test('prefers the linked issue the job already resolved', async () => {
        await runFollowUp({ linkedIssue: { owner: 'integry', repo: 'propr', number: 77 } });
        assert.deepEqual(pull(ORIGINAL_PR).assignees, ['dana']);
    });

    test('a linked issue in another repository is read there, not as the same-numbered local issue', async () => {
        policy = { enabled: true, defaultAssignee: null, requestReview: true };
        await runFollowUp({ linkedIssue: { owner: 'acme', repo: 'tracker', number: 77 } });
        assert.deepEqual(pull(ORIGINAL_PR).assignees, ['erin']);
        assert.deepEqual(pull(ORIGINAL_PR).requestedReviewers, ['erin']);
        const issueReads = github.calls.filter(call => call.route === 'GET /repos/{owner}/{repo}/issues/{issue_number}');
        assert.deepEqual(issueReads.map(call => call.parameters), [{ owner: 'acme', repo: 'tracker', issue_number: 77 }]);
    });

    test('the publication checkpoint saves the resolved source issue', async () => {
        const linkedIssue = { owner: 'acme', repo: 'tracker', number: 77 };
        await runFollowUp({ continuationPr: CONTINUATION_PR, linkedIssue });
        assert.deepEqual(pushedCompletion?.linkedIssue, linkedIssue);
    });

    test('a recovered publication assigns the source issue saved at checkpoint, not one parsed from the body', async () => {
        // `Fix #12` is a closing keyword GitHub resolves but the body parser does not.
        pull(CONTINUATION_PR).body = 'Continuation of #34.\n\nFix #12';
        await runFollowUp({
            continuationPr: CONTINUATION_PR, commit: 'e'.repeat(40),
            recoveredCompletion: { linkedIssue: { owner: 'integry', repo: 'propr', number: 12 } },
        });
        assert.equal(pushedCompletion, undefined, 'recovery does not commit or push again');
        assert.deepEqual(pull(CONTINUATION_PR).assignees, ['alice']);
    });

    test('a recovered publication from a cross-repository checkpoint keeps the issue\'s repository', async () => {
        await runFollowUp({
            continuationPr: CONTINUATION_PR,
            recoveredCompletion: { linkedIssue: { owner: 'acme', repo: 'tracker', number: 77 } },
        });
        assert.deepEqual(pull(CONTINUATION_PR).assignees, ['erin']);
    });

    test('a legacy checkpoint without a saved source issue falls back to the pull request body', async () => {
        await runFollowUp({ continuationPr: CONTINUATION_PR, recoveredCompletion: {} });
        assert.deepEqual(pull(CONTINUATION_PR).assignees, ['alice']);
    });

    test('assigns the configured default assignee when one is set', async () => {
        policy = { enabled: true, defaultAssignee: 'carol', requestReview: false };
        await runFollowUp();
        assert.deepEqual(pull(ORIGINAL_PR).assignees, ['carol']);
        assert.ok(!github.calls.some(call => call.route === 'GET /repos/{owner}/{repo}/issues/{issue_number}'));
    });

    test('skips, and says why, when the pull request has no linked source issue', async () => {
        pull(ORIGINAL_PR).body = 'No issue reference here';
        await runFollowUp();
        assert.deepEqual(assignmentWrites(), []);
        assert.match(String(assignmentEvents()[0].metadata.reason), /no linked source issue/);
    });

    test('a follow-up that produced no commit performs no assignment and no review request', async () => {
        policy = { enabled: true, defaultAssignee: null, requestReview: true };
        const result = await runFollowUp({ commit: null });
        assert.equal(result.commitHash, undefined);
        assert.equal(resolveRepositoryAutoAssignment.mock.callCount(), 0);
        assert.deepEqual(assignmentWrites(), []);
        assert.deepEqual(assignmentEvents(), []);
        assert.equal(taskStates.get(TASK_ID), 'completed');
    });

    test('a /review run performs no assignment even though it completes', async () => {
        policy = { enabled: true, defaultAssignee: null, requestReview: true };
        await runFollowUp({ commandMode: 'review' });
        assert.equal(resolveRepositoryAutoAssignment.mock.callCount(), 0);
        assert.deepEqual(assignmentWrites(), []);
        assert.equal(taskStates.get(TASK_ID), 'completed');
    });

    test('a follow-up published to a continuation pull request assigns that pull request', async () => {
        policy = { enabled: true, defaultAssignee: null, requestReview: true };
        await runFollowUp({ continuationPr: CONTINUATION_PR });
        assert.deepEqual(pull(CONTINUATION_PR).assignees, ['alice']);
        assert.deepEqual(pull(CONTINUATION_PR).requestedReviewers, ['alice']);
        assert.deepEqual(pull(ORIGINAL_PR).assignees, []);
        assert.ok(assignmentWrites().every(call => (call.parameters.issue_number ?? call.parameters.pull_number) === CONTINUATION_PR));
        assert.equal(assignmentEvents()[0].metadata.historyMetadata?.autoAssignment
            && (assignmentEvents()[0].metadata.historyMetadata.autoAssignment as { prNumber: number }).prNumber, CONTINUATION_PR);
    });

    test('each commit is one opportunity: two follow-ups re-assign once per commit', async () => {
        await runFollowUp({ commit: '1'.repeat(40) });
        // Someone unassigns the author between the follow-ups.
        pull(ORIGINAL_PR).assignees = [];
        await runFollowUp({ commit: '2'.repeat(40) });
        assert.equal(assignmentWrites().length, 2);
        assert.deepEqual(pull(ORIGINAL_PR).assignees, ['alice']);
    });

    test('a retried completion for the same commit does not write again', async () => {
        await runFollowUp({ commit: '1'.repeat(40) });
        pull(ORIGINAL_PR).assignees = [];
        await runFollowUp({ commit: '1'.repeat(40) });
        assert.equal(assignmentWrites().length, 1);
        assert.match(String(assignmentEvents()[1].metadata.reason), /already assigned/);
    });

    test('the review request is not duplicated across the implementation and follow-up opportunities', async () => {
        policy = { enabled: true, defaultAssignee: null, requestReview: true };
        const implementation = await autoAssignImplementationPullRequest({
            owner: 'integry', repo: 'propr', issueNumber: 12, prNumber: ORIGINAL_PR, taskId: 'task-implementation',
            octokit, redis: redisClient, logger: logger as never,
        });
        assert.equal(implementation.review?.status, 'requested');
        await runFollowUp({ commit: '1'.repeat(40) });
        await runFollowUp({ commit: '2'.repeat(40) });
        const reviewRequests = github.calls.filter(call => call.route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers');
        assert.equal(reviewRequests.length, 1);
        assert.deepEqual(pull(ORIGINAL_PR).requestedReviewers, ['alice']);
        assert.ok(assignmentEvents().every(entry => /review not requested: a review from alice is already requested/.test(String(entry.metadata.reason))));
    });

    test('a manual assignee added between follow-ups still holds afterwards', async () => {
        await runFollowUp({ commit: '1'.repeat(40) });
        pull(ORIGINAL_PR).assignees = ['bob'];
        await runFollowUp({ commit: '2'.repeat(40) });
        assert.deepEqual(pull(ORIGINAL_PR).assignees, ['bob', 'alice']);
        for (const call of setTaskAssignees.mock.calls) assert.equal(call.arguments[2].mode, 'add');
    });

    test('an assignment failure is logged and the follow-up still completes with its commit and comment', async () => {
        github.failAssign = true;
        const result = await runFollowUp();
        assert.deepEqual(result, { commitHash: 'c'.repeat(40), partial: false });
        assert.ok(github.calls.some(call => call.route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'));
        assert.equal(taskStates.get(TASK_ID), 'completed');
        assert.equal(history.at(-1)?.metadata.commitHash, 'c'.repeat(40));
        assert.ok(logs.some(log => log.level === 'warn' && log.message === 'Pull request auto-assignment failed'));
        assert.match(String(assignmentEvents()[0].metadata.reason), /assignment failed: GitHub is down/);
    });

    test('a policy read failure does not fail the follow-up', async () => {
        policyError = new Error('database unavailable');
        const result = await runFollowUp();
        assert.equal(result.commitHash, 'c'.repeat(40));
        assert.equal(taskStates.get(TASK_ID), 'completed');
        assert.deepEqual(assignmentWrites(), []);
    });

    test('the task timeline shows the follow-up assignment before completion', async () => {
        await runFollowUp();
        const events = assignmentEvents();
        assert.equal(events.length, 1);
        assert.equal(events[0].state, 'claude_execution', 'recorded in the running state, not as a new terminal one');
        assert.equal(events[0].metadata.reason, 'After follow-up: Assigned pull request to alice');
        assert.deepEqual(events[0].metadata.historyMetadata?.autoAssignment, {
            opportunity: 'followup_done', status: 'assigned', reason: 'assigned alice', assignee: 'alice', prNumber: ORIGINAL_PR,
        });
        assert.ok(history.indexOf(events[0]) < history.findIndex(entry => entry.state === 'completed'));
    });
});
