import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
let planIssue: { draft_id: string; issue_number: number } | null = null;
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => { throw new Error('use the fake client'); } } });
await mock.module('../src/config/planIssueManager.js', { namedExports: { findPlanIssueByRepoAndPR: async () => planIssue } });

const { gateAutoMergeArming, reevaluateArmedAutoMergeOnNewHead, handleAutoMergePolicyPullRequestEvent, loadBaseAutoMergePolicy } = await import('../src/services/autoMergeGate.js');
type GateOctokit = import('../src/services/autoMergeGate.js').AutoMergeGateOctokit;

await database.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('repository'); table.integer('issue_number'); table.string('created_at');
});
await database.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state'); table.string('timestamp'); table.text('reason'); table.text('metadata');
});
after(async () => database.destroy());

/**
 * A fake GitHub: workflow files differ per ref, so a policy read from the head
 * branch would be observable. Files and head SHA describe the PR's current diff.
 */
interface FakeRepo {
    workflowByRef: Record<string, string | undefined>;
    files: Array<{ filename: string; previous_filename?: string }>;
    headSha: string;
    baseRef: string;
    headRef: string;
    autoMerge?: { enabled_by: { login: string; type: string } } | null;
    /** Runs while the files list is being fetched, to simulate concurrent PR changes. */
    onListFiles?: () => void;
    failFiles?: boolean;
    changedFiles?: number;
    repo?: Record<string, boolean>;
}

function fakeGitHub(state: FakeRepo) {
    const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    const graphqlCalls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const octokit: GateOctokit = {
        async request(route, params = {}) {
            calls.push({ route, params });
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { number: params.pull_number, node_id: 'PR_node', base: { ref: state.baseRef }, head: { ref: state.headRef, sha: state.headSha },
                    changed_files: state.changedFiles ?? state.files.length, auto_merge: state.autoMerge ?? null } };
            }
            if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
                const content = state.workflowByRef[params.ref as string];
                if (content === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
                return { data: { type: 'file', encoding: 'base64', size: content.length, content: Buffer.from(content).toString('base64'), sha: 'blob' } };
            }
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files') {
                if (state.failFiles) throw Object.assign(new Error('Server Error'), { status: 502 });
                state.onListFiles?.();
                const page = params.page as number; const perPage = params.per_page as number;
                return { data: state.files.slice((page - 1) * perPage, page * perPage) };
            }
            if (route === 'GET /repos/{owner}/{repo}') return { data: state.repo ?? {} };
            if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') return { data: {} };
            throw new Error(`Unexpected request ${route}`);
        },
        async graphql<T>(query: string, variables?: Record<string, unknown>) {
            graphqlCalls.push({ query, variables });
            return {} as T;
        },
    };
    const comments = () => calls.filter(call => call.route.startsWith('POST ')).map(call => call.params.body as string);
    return { octokit, calls, graphqlCalls, comments };
}

const PROTECTING_POLICY = 'auto_merge:\n  method: rebase\n  protected_paths:\n    - "migrations/**"\n';
const PERMISSIVE_POLICY = 'auto_merge:\n  enabled: true\n';
const PROPR_ARMED = { enabled_by: { login: 'propr-dev[bot]', type: 'Bot' } };
const botLogin = async () => 'propr-dev[bot]';

beforeEach(async () => {
    await database('tasks').delete();
    await database('task_history').delete();
    await database('tasks').insert({ task_id: 'task-1', repository: 'acme/repo', issue_number: 7, created_at: '2026-10-06T00:00:00.000Z' });
    await database('task_history').insert({ task_id: 'task-1', state: 'completed', timestamp: '2026-10-06T00:00:00.000Z', reason: 'done', metadata: '{}' });
    planIssue = null;
});

async function decisionEvents() {
    return (await database('task_history').whereNot({ reason: 'done' }).orderBy('history_id'))
        .map(row => ({ ...row, metadata: JSON.parse(row.metadata) }));
}

test('the policy is loaded from the base ref, never the head ref', async () => {
    // The agent's head branch tries to switch auto-merge protection off.
    const github = fakeGitHub({
        workflowByRef: { main: PROTECTING_POLICY, 'agent-branch': 'auto_merge:\n  protected_paths: []\n' },
        files: [{ filename: 'migrations/001.sql' }], headSha: 'head1', baseRef: 'main', headRef: 'agent-branch',
    });
    const result = await gateAutoMergeArming({ owner: 'acme', repo: 'repo', prNumber: 70, opportunity: 'initial_pr', issueNumber: 7, log }, { octokit: github.octokit, database });
    assert.equal(result.arm, false);
    assert.equal(result.reason, 'skipped_protected_path');
    assert.deepEqual(result.matchedPaths, ['migrations/001.sql']);
    const refs = github.calls.filter(call => call.route.includes('/contents/')).map(call => call.params.ref);
    assert.deepEqual(refs, ['main']);
    // The skip is explained once on the PR; nothing touches the labels.
    assert.equal(github.comments().length, 1);
    assert.match(github.comments()[0], /skipped_protected_path/);
    assert.equal(github.calls.some(call => call.route.includes('/labels')), false);
});

test('a head-branch policy cannot protect itself from an unprotected base either', async () => {
    const policy = await loadBaseAutoMergePolicy(fakeGitHub({
        workflowByRef: { main: PERMISSIVE_POLICY, feature: 'auto_merge:\n  enabled: false\n' }, files: [], headSha: 'h', baseRef: 'main', headRef: 'feature',
    }).octokit, 'acme', 'repo', 'main');
    assert.deepEqual(policy, { status: 'valid', config: { enabled: true } });
});

test('an allowed PR arms with the policy method and records exactly one event', async () => {
    const github = fakeGitHub({ workflowByRef: { main: PROTECTING_POLICY }, files: [{ filename: 'src/app.ts' }], headSha: 'head1', baseRef: 'main', headRef: 'f' });
    const result = await gateAutoMergeArming({ owner: 'acme', repo: 'repo', prNumber: 70, opportunity: 'initial_pr', taskId: 'task-1', log }, { octokit: github.octokit, database });
    assert.equal(result.arm, true);
    assert.equal(result.mergeMethod, 'REBASE');
    assert.equal(github.comments().length, 0);
    const events = await decisionEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].state, 'completed', 'the event keeps the task lifecycle state');
    assert.deepEqual(events[0].metadata.autoMergeDecision, {
        reason: 'armed', arm: true, opportunity: 'initial_pr', prNumber: 70, method: 'rebase', headSha: 'head1', baseRef: 'main', policyPath: '.propr/workflow.yml',
    });
});

test('without a configured method the repository default is used', async () => {
    const github = fakeGitHub({ workflowByRef: {}, files: [{ filename: 'a.ts' }], headSha: 'h', baseRef: 'main', headRef: 'f', repo: { allow_squash_merge: false, allow_merge_commit: true } });
    const result = await gateAutoMergeArming({ owner: 'acme', repo: 'repo', prNumber: 70, opportunity: 'ultrafix_goal', log }, { octokit: github.octokit, database });
    assert.equal(result.mergeMethod, 'MERGE');
});

test('the skipped event names matching paths and finds the task by issue number', async () => {
    const github = fakeGitHub({ workflowByRef: {}, files: [{ filename: 'docs/new.md', previous_filename: '.propr/old.md' }], headSha: 'h', baseRef: 'main', headRef: 'f' });
    const result = await gateAutoMergeArming({ owner: 'acme', repo: 'repo', prNumber: 70, opportunity: 'ultrafix_goal', issueNumber: 7, log }, { octokit: github.octokit, database });
    assert.equal(result.reason, 'skipped_protected_path', 'a rename out of .propr/** is still a .propr change');
    const events = await decisionEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 'task-1');
    assert.deepEqual(events[0].metadata.autoMergeDecision.matchedPaths, ['.propr/old.md']);
    assert.match(events[0].reason, /not armed.*skipped_protected_path/);
});

for (const [name, state, reason] of [
    ['invalid base policy', { workflowByRef: { main: 'auto_merge:\n  method: octopus\n' } }, 'skipped_policy_invalid'],
    ['diff API error', { workflowByRef: {}, failFiles: true }, 'skipped_diff_unavailable'],
    ['truncated diff', { workflowByRef: {}, changedFiles: 5000 }, 'skipped_diff_unavailable'],
    ['empty diff', { workflowByRef: {}, files: [] }, 'skipped_empty_diff'],
    ['disabled policy', { workflowByRef: { main: 'auto_merge:\n  enabled: false\n' } }, 'skipped_disabled'],
] as const) {
    test(`fails closed: ${name}`, async () => {
        const github = fakeGitHub({ files: [{ filename: 'a.ts' }], headSha: 'h', baseRef: 'main', headRef: 'f', ...state } as FakeRepo);
        const result = await gateAutoMergeArming({ owner: 'acme', repo: 'repo', prNumber: 70, opportunity: 'initial_pr', taskId: 'task-1', log }, { octokit: github.octokit, database });
        assert.equal(result.arm, false);
        assert.equal(result.reason, reason);
        assert.equal(github.comments().length, 1);
        assert.equal((await decisionEvents()).length, 1);
    });
}

test('a skipped arm for an Epic queue head marks the queue waiting for a human merge', async () => {
    planIssue = { draft_id: 'draft', issue_number: 7 };
    const marks: unknown[] = [];
    const github = fakeGitHub({ workflowByRef: {}, files: [{ filename: '.propr/workflow.yml' }], headSha: 'h', baseRef: 'main', headRef: 'f' });
    await gateAutoMergeArming({ owner: 'acme', repo: 'repo', prNumber: 70, opportunity: 'epic_queue_advance', taskId: 'task-1', log },
        { octokit: github.octokit, database, markEpicQueueAwaitingHumanMerge: async input => { marks.push(input); return true; } });
    assert.deepEqual(marks, [{ draftId: 'draft', issueNumber: 7, prNumber: 70, reason: 'skipped_protected_path' }]);
});

test('a new head touching a protected path disarms ProPR-armed auto-merge and comments', async () => {
    planIssue = { draft_id: 'draft', issue_number: 7 };
    const github = fakeGitHub({
        workflowByRef: { main: PROTECTING_POLICY }, files: [{ filename: 'src/app.ts' }, { filename: 'migrations/002.sql' }],
        headSha: 'abcdef123', baseRef: 'main', headRef: 'f', autoMerge: PROPR_ARMED,
    });
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin });
    assert.equal(result.disarmed, true);
    assert.equal(github.graphqlCalls.length, 1);
    assert.match(github.graphqlCalls[0].query, /disablePullRequestAutoMerge/);
    assert.deepEqual(github.graphqlCalls[0].variables, { pullRequestId: 'PR_node' });
    assert.equal(github.comments().length, 1);
    assert.match(github.comments()[0], /Auto-merge disarmed.*abcdef1.*migrations\/002\.sql/);
    const events = await decisionEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata.autoMergeDecision.action, 'disarmed');
    assert.equal(events[0].metadata.autoMergeDecision.opportunity, 'new_head');
});

test('a new head that still satisfies the policy keeps auto-merge armed', async () => {
    const github = fakeGitHub({ workflowByRef: { main: PROTECTING_POLICY }, files: [{ filename: 'src/app.ts' }], headSha: 'h2', baseRef: 'main', headRef: 'f', autoMerge: PROPR_ARMED });
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin });
    assert.equal(result.disarmed, false);
    assert.equal(github.graphqlCalls.length, 0);
    assert.equal(github.comments().length, 0);
    assert.equal((await decisionEvents()).length, 0);
});

test('auto-merge a person armed manually is left alone', async () => {
    const github = fakeGitHub({ workflowByRef: {}, files: [{ filename: '.propr/workflow.yml' }], headSha: 'h2', baseRef: 'main', headRef: 'f', autoMerge: { enabled_by: { login: 'maintainer', type: 'User' } } });
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin });
    assert.equal(result.disarmed, false);
    assert.equal(github.graphqlCalls.length, 0);
});

test('the webhook hook only re-evaluates armed open PRs on a new head or base', async () => {
    const github = fakeGitHub({ workflowByRef: {}, files: [{ filename: '.propr/x' }], headSha: 'h', baseRef: 'main', headRef: 'f', autoMerge: PROPR_ARMED });
    const event = (action: string, extra: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
        action, repository: { full_name: 'acme/repo' }, ...extra,
        pull_request: { number: 70, state: 'open', auto_merge: PROPR_ARMED, ...pr },
    }) as never;
    const deps = { octokit: github.octokit, database, botLogin };
    await handleAutoMergePolicyPullRequestEvent(event('labeled'), log, deps);
    await handleAutoMergePolicyPullRequestEvent(event('synchronize', {}, { auto_merge: null }), log, deps);
    await handleAutoMergePolicyPullRequestEvent(event('synchronize', {}, { state: 'closed' }), log, deps);
    await handleAutoMergePolicyPullRequestEvent(event('edited', { changes: { title: { from: 'x' } } }), log, deps);
    assert.equal(github.graphqlCalls.length, 0);
    await handleAutoMergePolicyPullRequestEvent(event('synchronize'), log, deps);
    await handleAutoMergePolicyPullRequestEvent(event('edited', { changes: { base: { ref: { from: 'dev' } } } }), log, deps);
    assert.equal(github.graphqlCalls.length, 2);
});

test('a PR retargeted while its files are listed is not armed with the old base policy', async () => {
    // main permits src/**; release protects it. The head and file count stay the same.
    const state: FakeRepo = {
        workflowByRef: { main: PERMISSIVE_POLICY, release: 'auto_merge:\n  protected_paths: ["src/**"]\n' },
        files: [{ filename: 'src/app.ts' }], headSha: 'h', baseRef: 'main', headRef: 'f',
    };
    state.onListFiles = () => { state.baseRef = 'release'; };
    const github = fakeGitHub(state);
    const result = await gateAutoMergeArming({ owner: 'acme', repo: 'repo', prNumber: 70, opportunity: 'initial_pr', taskId: 'task-1', log }, { octokit: github.octokit, database });
    assert.equal(result.arm, false);
    assert.equal(result.reason, 'skipped_diff_unavailable');
    assert.equal(github.comments().length, 1);
});

test('a retarget during re-evaluation withdraws ProPR-armed auto-merge', async () => {
    const state: FakeRepo = {
        workflowByRef: { main: PERMISSIVE_POLICY, release: 'auto_merge:\n  protected_paths: ["src/**"]\n' },
        files: [{ filename: 'src/app.ts' }], headSha: 'h', baseRef: 'main', headRef: 'f', autoMerge: PROPR_ARMED,
    };
    state.onListFiles = () => { state.baseRef = 'release'; };
    const github = fakeGitHub(state);
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin });
    assert.equal(result.decision?.arm, false);
    assert.equal(result.disarmed, true);
});

test('an uncompilable protected glob on the base is a commented policy_invalid skip', async () => {
    const github = fakeGitHub({ workflowByRef: { main: 'auto_merge:\n  protected_paths: ["[z-a]"]\n' }, files: [{ filename: 'src/app.ts' }], headSha: 'h', baseRef: 'main', headRef: 'f' });
    const result = await gateAutoMergeArming({ owner: 'acme', repo: 'repo', prNumber: 70, opportunity: 'initial_pr', taskId: 'task-1', log }, { octokit: github.octokit, database });
    assert.equal(result.arm, false);
    assert.equal(result.reason, 'skipped_policy_invalid');
    assert.equal(github.comments().length, 1);
    assert.match(github.comments()[0], /skipped_policy_invalid/);
    assert.equal((await decisionEvents()).length, 1);
});

test('an uncompilable protected glob disarms ProPR-armed auto-merge on a new head', async () => {
    const github = fakeGitHub({
        workflowByRef: { main: 'auto_merge:\n  protected_paths: ["[z-a]"]\n' }, files: [{ filename: 'src/app.ts' }],
        headSha: 'h2', baseRef: 'main', headRef: 'f', autoMerge: PROPR_ARMED,
    });
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin });
    assert.equal(result.disarmed, true);
    assert.equal(result.decision?.reason, 'skipped_policy_invalid');
    assert.equal(github.graphqlCalls.length, 1);
    assert.equal(github.comments().length, 1);
});

test('auto-merge another GitHub App enabled is left alone', async () => {
    const github = fakeGitHub({
        workflowByRef: {}, files: [{ filename: '.propr/workflow.yml' }], headSha: 'h2', baseRef: 'main', headRef: 'f',
        autoMerge: { enabled_by: { login: 'other-automation[bot]', type: 'Bot' } },
    });
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin });
    assert.equal(result.disarmed, false);
    assert.equal(github.graphqlCalls.length, 0);
    assert.equal(github.comments().length, 0);
});

test('auto-merge is left alone when ProPR cannot resolve its own identity', async () => {
    const github = fakeGitHub({ workflowByRef: {}, files: [{ filename: '.propr/workflow.yml' }], headSha: 'h2', baseRef: 'main', headRef: 'f', autoMerge: PROPR_ARMED });
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log },
        { octokit: github.octokit, database, botLogin: async () => { throw new Error('installation lookup failed'); } });
    assert.equal(result.disarmed, false);
    assert.equal(github.graphqlCalls.length, 0);
});

test('ProPR identity matching ignores login case', async () => {
    const github = fakeGitHub({ workflowByRef: {}, files: [{ filename: '.propr/workflow.yml' }], headSha: 'h2', baseRef: 'main', headRef: 'f', autoMerge: PROPR_ARMED });
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin: async () => 'ProPR-Dev[bot]' });
    assert.equal(result.disarmed, true);
});
