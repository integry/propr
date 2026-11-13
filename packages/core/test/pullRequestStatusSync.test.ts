import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import knexFactory, { type Knex } from 'knex';
import type { PullRequestStatusSyncDeps } from '../src/services/pullRequestStatus/pullRequestStatusSync.js';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../src/db/connection.js');
const { PR_STATUS_BLOCK_START, extractPullRequestStatusBlock, stripPullRequestStatusBlock } = await import('../src/services/pullRequestStatus/pullRequestStatusBlock.js');
const {
    disablePullRequestStatusSync, enablePullRequestStatusSync, initialPullRequestStatusBlock,
    resolvePullRequestsForCommitStatus, syncPullRequestStatus, updatePullRequestBody,
} = await import('../src/services/pullRequestStatus/pullRequestStatusSync.js');
const { loadPullRequestStatusFacts } = await import('../src/services/pullRequestStatus/pullRequestStatusFacts.js');
const { requestPullRequestStatusSyncForCommit, setPullRequestStatusCommitSyncRunner } = await import('../src/services/pullRequestStatus/pullRequestStatusSignal.js');
const { signalPullRequestStatusFromWebhook } = await import('../src/webhook/pullRequestStatusWebhook.js');
const { processWebhookEvent } = await import('../src/webhook/webhookHandler.js');
const { resolveRepositoryPrTitleStatus } = await import('../src/config/repositoryPrTitleStatusSetting.js');

const REPOSITORY = 'integry/propr';
const PR = 42;
const HUMAN_BODY = [
    '## Summary', '', 'Implementation summary.', '',
    'A human edit.', '',
    '<!-- propr-continuation:task-1 -->', '',
    '<!-- propr:visual-preview -->', '### Visual preview', '![desktop](https://github.com/user-attachments/assets/1)', '<!-- /propr:visual-preview -->', '',
    'Fixes #12',
].join('\n');

class FakeRedis {
    values = new Map<string, string>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async set(key: string, value: string, ...args: unknown[]) {
        if (args.includes('NX') && this.values.has(key)) return null;
        this.values.set(key, value);
        return 'OK';
    }
    async del(key: string) { return this.values.delete(key) ? 1 : 0; }
    async eval(_script: string, _keys: number, key: string, token: string) {
        if (this.values.get(key) !== token) return 0;
        this.values.delete(key);
        return 1;
    }
}

interface FakePull { state: string; merged: boolean; mergeable: boolean | null; body: string; head: { sha: string; ref: string } }

class FakeGitHub {
    pull: FakePull = { state: 'open', merged: false, mergeable: true, body: HUMAN_BODY, head: { sha: 'head-1', ref: '12-feature' } };
    checkRuns: Array<{ name: string; status: string; conclusion: string | null }> = [{ name: 'unit', status: 'completed', conclusion: 'success' }];
    commitStatus: { state: string; total_count: number; statuses: Array<{ context: string; state: string }> } = { state: 'pending', total_count: 0, statuses: [] };
    calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    patches: string[] = [];
    async request(route: string, params: Record<string, unknown>) {
        this.calls.push({ route, params });
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: structuredClone(this.pull) };
        if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') {
            this.pull.body = String(params.body);
            this.patches.push(this.pull.body);
            return { data: { body: this.pull.body } };
        }
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') {
            const perPage = Number(params.per_page ?? 30);
            const page = Number(params.page ?? 1);
            return { data: { total_count: this.checkRuns.length, check_runs: this.checkRuns.slice((page - 1) * perPage, page * perPage) } };
        }
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/status') return { data: this.commitStatus };
        throw new Error(`unexpected route ${route}`);
    }
    writes() { return this.calls.filter(call => !call.route.startsWith('GET ')); }
}

let database: Knex;
let github: FakeGitHub;
let redis: FakeRedis;
let clock: Date;

before(async () => {
    database = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.schema.createTable('tasks', table => {
        table.string('task_id').primary(); table.string('repository'); table.integer('issue_number'); table.string('task_type');
        table.string('created_at'); table.json('initial_job_data'); table.integer('pr_number');
    });
    await database.schema.createTable('task_history', table => { table.increments('history_id'); table.string('task_id'); table.string('state'); });
    await database.schema.createTable('plan_issues', table => {
        table.increments('id'); table.string('repository'); table.integer('pr_number'); table.integer('issue_number'); table.string('draft_id'); table.string('status');
    });
    await database.schema.createTable('goals', table => { table.string('goal_id'); table.string('repository'); table.integer('final_pr_number'); });
    await database.schema.createTable('review_scores', table => {
        table.increments('id'); table.string('repository_id'); table.integer('pr_number'); table.integer('score'); table.string('created_at');
    });
});

after(async () => {
    await database.destroy();
    await closeConnection();
});

beforeEach(async () => {
    for (const name of ['tasks', 'task_history', 'plan_issues', 'goals', 'review_scores']) await database(name).del();
    github = new FakeGitHub();
    redis = new FakeRedis();
    clock = new Date('2026-11-13T09:00:00Z');
});

function deps(): Partial<PullRequestStatusSyncDeps> {
    return {
        github,
        redis: redis as never,
        now: () => clock,
        sources: {
            db: database,
            redis: redis as never,
            loadRatingGoal: async () => 7,
            loadNonBlockingChecks: async () => [],
            countQueuedJobs: async () => 0,
        },
    };
}

let taskSeq = 0;
async function addTask(type: string, state: string, extra: Record<string, unknown> = {}, prNumber: number | null = type === 'issue' ? PR : null): Promise<string> {
    const taskId = `task-${++taskSeq}`;
    const createdAt = new Date(Date.parse('2026-11-13T08:00:00Z') + taskSeq * 60_000).toISOString();
    await database('tasks').insert({
        task_id: taskId, repository: REPOSITORY, issue_number: type === 'issue' ? 12 : PR, task_type: type, created_at: createdAt,
        initial_job_data: JSON.stringify(extra), pr_number: prNumber,
    });
    await database('task_history').insert({ task_id: taskId, state });
    return taskId;
}

async function setTaskState(taskId: string, state: string): Promise<void> {
    await database('task_history').insert({ task_id: taskId, state });
}

function statusLine(): string {
    return extractPullRequestStatusBlock(github.pull.body)?.split('\n')[1] ?? '';
}

/** The block a new pull request is created with, as the worker builds it. */
async function initialBlock(): Promise<string | null> {
    enablePullRequestStatusSync(deps());
    try {
        return await initialPullRequestStatusBlock(REPOSITORY, { now: () => clock });
    } finally {
        disablePullRequestStatusSync();
    }
}

async function sync(): Promise<string> {
    clock = new Date(clock.getTime() + 60_000);
    return await syncPullRequestStatus(REPOSITORY, PR, deps());
}

test('the block follows a pull request through its transitions and keeps the rest of the body', async () => {
    // Created with the block already in its body, while the creating task still runs.
    const initial = await initialBlock();
    assert.ok(initial);
    github.pull.body = `${initial}\n\n${HUMAN_BODY}`;
    assert.match(statusLine(), /🔨 Implementing/);
    const implementation = await addTask('issue', 'completed');
    assert.ok(implementation);

    const lines: string[] = [];
    const record = async (expected: RegExp) => {
        assert.equal(await sync(), 'updated');
        assert.match(statusLine(), expected);
        assert.equal(stripPullRequestStatusBlock(github.pull.body), HUMAN_BODY, 'human edit, preview section and continuation marker unchanged');
        assert.equal(github.pull.body.split(PR_STATUS_BLOCK_START).length, 2, 'exactly one block');
        lines.push(statusLine());
    };

    const followUp = await addTask('pr-comment', 'processing', { comments: [{ commandMode: 'default' }] });
    await record(/🔨 Follow-up in progress/);
    await setTaskState(followUp, 'completed');

    const review = await addTask('pr-comment', 'processing', { comments: [{ commandMode: 'review' }] });
    await record(/🔨 Review in progress/);
    await setTaskState(review, 'completed');
    await database('review_scores').insert({ repository_id: REPOSITORY, pr_number: PR, score: 6, created_at: '2026-11-13T09:10:00Z' });
    await record(/⚠️ Needs you · review below goal 7\/10 · review 6\/10/);

    const state = { goal: 7, maxCycles: 5, cycleCount: 1, active: true, completionStatus: null, completionReason: null, finalScore: null, completedAt: null };
    redis.values.set(`ultrafix:state:integry:propr:${PR}`, JSON.stringify(state));
    const fix = await addTask('pr-comment', 'claude_execution', { commandMode: 'fix' });
    await record(/🔨 Follow-up in progress · Ultrafix cycle 2 of 5 · last review 6\/10/);
    await setTaskState(fix, 'completed');

    redis.values.set(`ultrafix:ci-wait:integry:propr:${PR}`, JSON.stringify({ headSha: 'head-2' }));
    github.checkRuns = [{ name: 'unit', status: 'in_progress', conclusion: null }];
    await record(/🔨 Waiting for CI · Ultrafix cycle 2 of 5 .*checks: 1 pending/);

    redis.values.delete(`ultrafix:ci-wait:integry:propr:${PR}`);
    github.checkRuns = [{ name: 'unit', status: 'completed', conclusion: 'success' }];
    redis.values.set(`ultrafix:state:integry:propr:${PR}`, JSON.stringify({
        ...state, cycleCount: 5, active: false, completionStatus: 'failed', completionReason: 'cycles_exhausted', finalScore: 6, completedAt: '2026-11-13T23:00:00Z',
    }));
    await record(/⚠️ Needs you · Ultrafix stopped after 5 cycles at 6\/10/);

    assert.equal(new Set(lines).size, lines.length, 'every transition changed the block');
    assert.equal(github.patches.length, lines.length);
});

test('no PATCH is sent when the rendered status is unchanged, even as time passes', async () => {
    await addTask('issue', 'completed');
    assert.equal(await sync(), 'updated');
    assert.match(statusLine(), /✅ Ready · checks: 1 passed/);
    const writes = github.writes().length;
    assert.equal(await sync(), 'unchanged');
    assert.equal(await sync(), 'unchanged');
    assert.equal(github.writes().length, writes);
});

test('goal reached with a later failed check shows needs attention, never ready', async () => {
    await addTask('issue', 'completed');
    await database('review_scores').insert({ repository_id: REPOSITORY, pr_number: PR, score: 8, created_at: '2026-11-13T09:10:00Z' });
    redis.values.set(`ultrafix:state:integry:propr:${PR}`, JSON.stringify({ goal: 7, maxCycles: 5, cycleCount: 2, active: false, completionStatus: 'succeeded', completionReason: 'goal_reached', finalScore: 8, completedAt: '2026-11-13T09:10:00Z' }));
    github.checkRuns = [{ name: 'unit', status: 'queued', conclusion: null }];
    await sync();
    assert.match(statusLine(), /🔨 Waiting for CI/);
    github.checkRuns = [{ name: 'unit', status: 'completed', conclusion: 'failure' }];
    await sync();
    assert.match(statusLine(), /⚠️ Needs you · failed: unit · review 8\/10 · checks: 1 failed/);
});

test('the block is removed when the pull request is merged or closed', async () => {
    await addTask('issue', 'completed');
    await sync();
    assert.ok(extractPullRequestStatusBlock(github.pull.body));
    github.pull.state = 'closed';
    github.pull.merged = true;
    assert.equal(await sync(), 'removed');
    assert.equal(github.pull.body, HUMAN_BODY);
    assert.equal(await sync(), 'skipped', 'nothing left to remove');

    github.pull = { ...github.pull, state: 'open', merged: false };
    await sync();
    github.pull.state = 'closed';
    assert.equal(await sync(), 'removed');
    assert.equal(github.pull.body, HUMAN_BODY);
});

test('the block is written in every repository, whatever the title setting says', async () => {
    await addTask('issue', 'completed');
    assert.equal(await sync(), 'updated');
    assert.ok(extractPullRequestStatusBlock(github.pull.body));
    assert.equal(await initialPullRequestStatusBlock(REPOSITORY), null, 'a process that does not maintain the status writes no block');

    // The setting controls the title only and is on unless a repository turns it off.
    assert.equal(resolveRepositoryPrTitleStatus([], REPOSITORY), true);
    assert.equal(resolveRepositoryPrTitleStatus([{ id: 'a', name: 'Integry/Propr', enabled: true }], REPOSITORY), true);
    assert.equal(resolveRepositoryPrTitleStatus([{ id: 'a', name: REPOSITORY, enabled: true, prTitleStatus: false }], REPOSITORY), false);
    assert.equal(resolveRepositoryPrTitleStatus([{ id: 'a', name: 'integry/other', enabled: true, prTitleStatus: false }], REPOSITORY), true);
});

test('pull requests ProPR did not create get no block', async () => {
    assert.equal(await sync(), 'skipped');
    assert.equal(github.writes().length, 0);
    assert.equal(github.pull.body, HUMAN_BODY);
});

test('concurrent transitions do not interleave their body writes', async () => {
    await addTask('issue', 'completed');
    await Promise.all([sync(), sync(), sync()]);
    assert.equal(github.pull.body.split(PR_STATUS_BLOCK_START).length, 2);
    assert.equal(stripPullRequestStatusBlock(github.pull.body), HUMAN_BODY);
});

test('other body writers keep the status block and skip unchanged bodies', async () => {
    await addTask('issue', 'completed');
    await sync();
    const block = extractPullRequestStatusBlock(github.pull.body);
    const published = `${HUMAN_BODY}\n\n<!-- propr:visual-preview -->\nNew preview\n<!-- /propr:visual-preview -->`;
    const response = await updatePullRequestBody(github as never, { owner: 'integry', repo: 'propr', pullNumber: PR, body: published }, { preserveStatusBlock: true, redis: redis as never });
    assert.equal(extractPullRequestStatusBlock(github.pull.body), block);
    assert.equal(stripPullRequestStatusBlock(github.pull.body), published);
    assert.equal((response as { data: { body: string } }).data.body, github.pull.body);

    const patches = github.patches.length;
    await updatePullRequestBody(github as never, { owner: 'integry', repo: 'propr', pullNumber: PR, body: published }, { preserveStatusBlock: true, redis: redis as never });
    assert.equal(github.patches.length, patches, 'unchanged body is not sent');
});

test('an edited webhook caused by a status update triggers no further work', async () => {
    const before = HUMAN_BODY;
    await addTask('issue', 'completed');
    await sync();
    const disposition = await processWebhookEvent({
        action: 'edited',
        changes: { body: { from: before } },
        repository: { full_name: REPOSITORY },
        pull_request: { number: PR, body: github.pull.body, title: 'x', head: { ref: '12-feature' }, base: { ref: 'main' } },
        sender: { login: 'propr[bot]' },
    }, 'pull_request', 'corr-1');
    assert.deepEqual(disposition, { status: 'ignored', reason: 'pull_request_status_edit' });
});

test('check runs past the page budget are not complete, so the pull request is never ready', async () => {
    await addTask('issue', 'completed');
    const passing = Array.from({ length: 300 }, (_, index) => ({ name: `unit-${index}`, status: 'completed', conclusion: 'success' }));
    github.checkRuns = [...passing, { name: 'integration', status: 'completed', conclusion: 'failure' }];
    const facts = await loadPullRequestStatusFacts(REPOSITORY, PR, { ...deps().sources!, github });
    assert.equal(facts.checks.complete, false, 'the unread fourth page may hold a failed run');
    assert.equal(facts.checks.failed, 0);
    await sync();
    assert.doesNotMatch(statusLine(), /Ready/);
    assert.match(statusLine(), /⚠️ Needs you · checks could not be read/);

    github.checkRuns = passing;
    const exact = await loadPullRequestStatusFacts(REPOSITORY, PR, { ...deps().sources!, github });
    assert.equal(exact.checks.complete, true, 'exactly three full pages are every run');
    await sync();
    assert.match(statusLine(), /✅ Ready · checks: 300 passed/);
});

test('reviewing or following up on a pull request a person opened does not make it a ProPR pull request', async () => {
    await addTask('pr-comment', 'completed', { comments: [{ commandMode: 'review' }] });
    await addTask('review', 'completed');
    await addTask('pr-comment', 'processing', { comments: [{ commandMode: 'default' }] }, PR);
    await addTask('merge_conflict', 'completed', {}, PR);
    const facts = await loadPullRequestStatusFacts(REPOSITORY, PR, { ...deps().sources!, github });
    assert.equal(facts.isProprPullRequest, false);
    assert.ok(facts.tasks.length > 0, 'the activity is still read');
    assert.equal(await sync(), 'skipped');
    assert.equal(github.writes().length, 0);
    assert.equal(github.pull.body, HUMAN_BODY);

    await addTask('issue', 'completed');
    assert.equal(await sync(), 'updated', 'an implementation task that produced the pull request is creation evidence');
});

test('a commit status change refreshes the pull requests of its commit', async () => {
    await addTask('issue', 'completed');
    github.checkRuns = [];
    github.commitStatus = { state: 'pending', total_count: 1, statuses: [{ context: 'ci/legacy', state: 'pending' }] };
    await sync();
    assert.match(statusLine(), /🔨 Waiting for CI/);

    const signalled: Array<[string, string]> = [];
    setPullRequestStatusCommitSyncRunner((repository, sha) => { signalled.push([repository, sha]); });
    try {
        signalPullRequestStatusFromWebhook({ repository: { full_name: REPOSITORY }, sha: 'abc1234', state: 'success', context: 'ci/legacy' }, 'status');
    } finally {
        setPullRequestStatusCommitSyncRunner(null);
    }
    assert.deepEqual(signalled, [[REPOSITORY, 'abc1234']]);

    const lookups: string[] = [];
    const finder = { findPullRequestsForCommit: async (_repository: string, sha: string) => { lookups.push(sha); return [PR]; } };
    assert.deepEqual(await resolvePullRequestsForCommitStatus(REPOSITORY, 'abc1234', { ...deps(), ...finder }), [PR]);
    lookups.length = 0;

    github.commitStatus = { state: 'success', total_count: 1, statuses: [{ context: 'ci/legacy', state: 'success' }] };
    enablePullRequestStatusSync({ ...deps(), ...finder });
    try {
        requestPullRequestStatusSyncForCommit(REPOSITORY, 'abc1234');
        requestPullRequestStatusSyncForCommit(REPOSITORY, 'abc1234');
        const deadline = Date.now() + 5_000;
        while (!/✅ Ready/.test(statusLine()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
        disablePullRequestStatusSync();
    }
    assert.match(statusLine(), /✅ Ready · checks: 1 passed/);
    assert.deepEqual(lookups, ['abc1234'], 'a burst of status events for one commit is one lookup');
});

test('the block a pull request was created with is confirmed without a PATCH, then kept up to date', async () => {
    const initial = await initialBlock();
    github.pull.body = `${initial}\n\n${HUMAN_BODY}`;
    const implementation = await addTask('issue', 'processing');
    github.checkRuns = [];
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    assert.equal(await sync(), 'unchanged', 'the synchronization confirms the initial block without a PATCH');
    assert.equal(github.writes().length, 0);
    await setTaskState(implementation, 'completed');
    assert.equal(await sync(), 'updated');
    assert.match(statusLine(), /✅ Ready/);
    assert.equal(stripPullRequestStatusBlock(github.pull.body), HUMAN_BODY);
});
