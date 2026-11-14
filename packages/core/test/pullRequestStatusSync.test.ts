import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import knexFactory, { type Knex } from 'knex';
import { PR_BODY_MAX_LENGTH } from '@propr/shared';
import type { PullRequestStatusSyncDeps } from '../src/services/pullRequestStatus/pullRequestStatusSync.js';
import type { PullRequestStatusScheduleOptions } from '../src/services/pullRequestStatus/pullRequestStatusReconcile.js';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../src/db/connection.js');
const { PR_STATUS_BLOCK_START, extractPullRequestStatusBlock, stripPullRequestStatusBlock } = await import('../src/services/pullRequestStatus/pullRequestStatusBlock.js');
const {
    disablePullRequestStatusSync, enablePullRequestStatusSync, initialPullRequestStatusBlock,
    PullRequestChangedDuringStatusSyncError, resolvePullRequestsForCommitStatus, setPullRequestStatusMergeabilityRefreshDelaysForTests, syncPullRequestStatus, updatePullRequestBody,
} = await import('../src/services/pullRequestStatus/pullRequestStatusSync.js');
const { MAX_STATUS_BACKFILL_REPOSITORIES, schedulePullRequestStatusBackfill, schedulePullRequestStatusForBasePush } = await import('../src/services/pullRequestStatus/pullRequestStatusReconcile.js');
const { loadPullRequestStatus, loadPullRequestStatusChecks, loadPullRequestStatusFacts } = await import('../src/services/pullRequestStatus/pullRequestStatusFacts.js');
const { PullRequestBodyLockLostError, setPullRequestBodyLockTimingForTests } = await import('../src/services/pullRequestStatus/pullRequestBodyLock.js');
// A second instance of the lock module stands in for another process (daemon vs worker): it has its own in-process chains.
const otherProcessLock = await import('../src/services/pullRequestStatus/pullRequestBodyLock.ts?process=other') as typeof import('../src/services/pullRequestStatus/pullRequestBodyLock.js');
const { requestPullRequestStatusSync, requestPullRequestStatusSyncForCommit, setPullRequestStatusCommitSyncRunner, setPullRequestStatusSyncRunner } = await import('../src/services/pullRequestStatus/pullRequestStatusSignal.js');
const { isRecordedPullRequestStatusWrite, recordPullRequestStatusWrite, resetPullRequestStatusProvenanceForTests } = await import('../src/services/pullRequestStatus/pullRequestStatusProvenance.js');
const { classifyPullRequestStatusEdit, signalPullRequestStatusFromWebhook } = await import('../src/webhook/pullRequestStatusWebhook.js');
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
    expiries = new Map<string, number>();
    failRenewals = false;
    private live(key: string) {
        const expiresAt = this.expiries.get(key);
        if (expiresAt !== undefined && Date.now() >= expiresAt) { this.values.delete(key); this.expiries.delete(key); }
        return this.values.get(key);
    }
    async get(key: string) { return this.live(key) ?? null; }
    async set(key: string, value: string, ...args: unknown[]) {
        if (args.includes('NX') && this.live(key) !== undefined) return null;
        this.values.set(key, value);
        const px = args.indexOf('PX');
        if (px >= 0) this.expiries.set(key, Date.now() + Number(args[px + 1]));
        else this.expiries.delete(key);
        return 'OK';
    }
    async del(key: string) { this.expiries.delete(key); return this.values.delete(key) ? 1 : 0; }
    async eval(script: string, _keys: number, key: string, token: string, ttl?: string) {
        if (script.includes('pexpire') && this.failRenewals) throw new Error('redis unavailable');
        if (this.live(key) !== token) return 0;
        if (script.includes('pexpire')) { this.expiries.set(key, Date.now() + Number(ttl)); return 1; }
        this.values.delete(key);
        this.expiries.delete(key);
        return 1;
    }
}

interface FakePull {
    state: string; merged: boolean; mergeable: boolean | null; body: string;
    head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { ref: string; sha: string };
}

class FakeGitHub {
    pull: FakePull = {
        state: 'open', merged: false, mergeable: true, body: HUMAN_BODY,
        head: { sha: 'head-1', ref: '12-feature', repo: { full_name: REPOSITORY } }, base: { ref: 'main', sha: 'base-1' },
    };
    checkRuns: Array<{ name: string; status: string; conclusion: string | null }> = [{ name: 'unit', status: 'completed', conclusion: 'success' }];
    commitStatus: { state: string; total_count: number; statuses: Array<{ context: string; state: string }> } = { state: 'pending', total_count: 0, statuses: [] };
    calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    patches: string[] = [];
    /** The open pull requests GitHub lists; by default the one pull request while it is open. */
    listed: Array<{ number: number; head: FakePull['head']; base: FakePull['base'] }> | null = null;
    /** Failures the next open pull request listings throw. */
    listFailures = 0;
    /** Failures the next check reads (check runs, legacy statuses) throw. */
    checkFailures = 0;
    async request(route: string, params: Record<string, unknown>) {
        this.calls.push({ route, params });
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: structuredClone(this.pull) };
        if (route === 'GET /repos/{owner}/{repo}/pulls') {
            if (this.listFailures > 0) { this.listFailures--; throw new Error('GitHub unavailable'); }
            const open = this.listed ?? (this.pull.state === 'open' ? [{ number: PR, head: this.pull.head, base: this.pull.base }] : []);
            const intoBase = params.base ? open.filter(pull => pull.base.ref === params.base) : open;
            const perPage = Number(params.per_page ?? 30);
            const page = Number(params.page ?? 1);
            return { data: structuredClone(intoBase.slice((page - 1) * perPage, page * perPage)) };
        }
        if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') {
            this.pull.body = String(params.body);
            this.patches.push(this.pull.body);
            return { data: { body: this.pull.body } };
        }
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') {
            if (this.checkFailures > 0) { this.checkFailures--; throw new Error('GitHub unavailable'); }
            const perPage = Number(params.per_page ?? 30);
            const page = Number(params.page ?? 1);
            return { data: { total_count: this.checkRuns.length, check_runs: this.checkRuns.slice((page - 1) * perPage, page * perPage) } };
        }
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/status') {
            if (this.checkFailures > 0) { this.checkFailures--; throw new Error('GitHub unavailable'); }
            return { data: pagedCommitStatus(this.commitStatus, params) };
        }
        throw new Error(`unexpected route ${route}`);
    }
    writes() { return this.calls.filter(call => !call.route.startsWith('GET ')); }
}

/** The combined status as GitHub pages it: the state and total with every page, the contexts page by page. */
function pagedCommitStatus(status: FakeGitHub['commitStatus'], params: Record<string, unknown>) {
    const perPage = Number(params.per_page ?? 30);
    const page = Number(params.page ?? 1);
    return { ...status, statuses: status.statuses.slice((page - 1) * perPage, page * perPage) };
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
        table.string('created_at');
    });
    await database.schema.createTable('task_drafts', table => {
        table.string('draft_id').primary(); table.string('repository'); table.json('context_config'); table.string('name'); table.boolean('paused').defaultTo(false);
    });
    await database.schema.createTable('epic_execution_queues', table => {
        table.string('draft_id').primary(); table.text('issues'); table.integer('cursor'); table.string('status'); table.boolean('ready'); table.boolean('parallel');
        table.string('blocked_reason');
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
    for (const name of ['tasks', 'task_history', 'plan_issues', 'task_drafts', 'goals', 'review_scores']) await database(name).del();
    github = new FakeGitHub();
    redis = new FakeRedis();
    clock = new Date('2026-11-13T09:00:00Z');
    resetPullRequestStatusProvenanceForTests();
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

/** The `edited` webhook GitHub sends for a body change from `from` to the pull request's current body. */
function editedWebhook(from: string, sender = 'octocat'): Record<string, unknown> {
    return {
        action: 'edited',
        changes: { body: { from } },
        repository: { full_name: REPOSITORY },
        pull_request: { number: PR, body: github.pull.body, title: 'x', head: { ref: '12-feature' }, base: { ref: 'main' } },
        sender: { login: sender },
    };
}

/** Runs `work` as the webhook process: status maintenance on, every status signal recorded instead of run. */
async function asWebhookProcess<T>(work: (signalled: Array<[string, number]>) => Promise<T>): Promise<T> {
    const signalled: Array<[string, number]> = [];
    enablePullRequestStatusSync(deps());
    setPullRequestStatusSyncRunner((repository, prNumber) => { signalled.push([repository, prNumber]); });
    try {
        return await work(signalled);
    } finally {
        disablePullRequestStatusSync();
    }
}

test('an edited webhook caused by a status update triggers no further work', async () => {
    const before = HUMAN_BODY;
    await addTask('issue', 'completed');
    await sync();
    await asWebhookProcess(async signalled => {
        const disposition = await processWebhookEvent(editedWebhook(before, 'propr[bot]'), 'pull_request', 'corr-1');
        assert.deepEqual(disposition, { status: 'ignored', reason: 'pull_request_status_edit' });
        assert.deepEqual(signalled, [], 'the status is not read again for ProPR\'s own write');

        // The webhook process has no memory of the write; the record it finds is the one shared through Redis.
        resetPullRequestStatusProvenanceForTests();
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook(before, 'propr[bot]'), 'pull_request'), 'own');
        assert.deepEqual(await processWebhookEvent(editedWebhook(before, 'propr[bot]'), 'pull_request', 'corr-2'), { status: 'ignored', reason: 'pull_request_status_edit' });
        assert.deepEqual(signalled, []);
    });
});

test('a person deleting the status block gets it reconciled, without other work', async () => {
    await addTask('issue', 'completed');
    await sync();
    const written = github.pull.body;
    github.pull.body = HUMAN_BODY;
    await asWebhookProcess(async signalled => {
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook(written), 'pull_request'), 'foreign');
        const disposition = await processWebhookEvent(editedWebhook(written), 'pull_request', 'corr-1');
        assert.deepEqual(disposition, { status: 'accepted', reason: 'pull_request_status_block_edited', billing: { seatConsumed: false } });
        assert.deepEqual(signalled, [[REPOSITORY, PR]], 'the status update is scheduled; no handler ran');
    });
    assert.equal(await sync(), 'updated');
    assert.match(statusLine(), /✅ Ready/);
    assert.equal(stripPullRequestStatusBlock(github.pull.body), HUMAN_BODY);
});

test('a person replacing the status block\'s text gets it reconciled', async () => {
    await addTask('issue', 'completed');
    await sync();
    const written = github.pull.body;
    github.pull.body = written.replace(statusLine(), '**ProPR** ⚠️ Needs you · typed by a person · updated 09:01 UTC');
    assert.notEqual(github.pull.body, written);
    await asWebhookProcess(async signalled => {
        assert.deepEqual(await processWebhookEvent(editedWebhook(written), 'pull_request', 'corr-1'),
            { status: 'accepted', reason: 'pull_request_status_block_edited', billing: { seatConsumed: false } });
        assert.deepEqual(signalled, [[REPOSITORY, PR]]);
    });
    assert.equal(await sync(), 'updated');
    assert.match(statusLine(), /✅ Ready/);
    assert.doesNotMatch(github.pull.body, /typed by a person/);
});

test('a person deleting the block a pull request was created with gets it reconciled', async () => {
    // The creation block is written with the pull request (an opened event), never as an edit ProPR recorded.
    const initial = await initialBlock();
    const created = `${initial}\n\n${HUMAN_BODY}`;
    await addTask('issue', 'completed');
    github.pull.body = HUMAN_BODY;
    await asWebhookProcess(async signalled => {
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook(created), 'pull_request'), 'foreign');
        await processWebhookEvent(editedWebhook(created), 'pull_request', 'corr-1');
        assert.deepEqual(signalled, [[REPOSITORY, PR]]);
    });
});

test('a block the status update removed is ProPR\'s own edit; one a person removed on a closed pull request is not', async () => {
    await addTask('issue', 'completed');
    await sync();
    const withBlock = github.pull.body;
    github.pull.state = 'closed';
    assert.equal(await sync(), 'removed');
    await asWebhookProcess(async signalled => {
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook(withBlock, 'propr[bot]'), 'pull_request'), 'own');
        assert.deepEqual(await processWebhookEvent(editedWebhook(withBlock, 'propr[bot]'), 'pull_request', 'corr-1'), { status: 'ignored', reason: 'pull_request_status_edit' });
        assert.deepEqual(signalled, []);
    });
});

test('after close and reopen, a person deleting the restored block gets it reconciled', async () => {
    await addTask('issue', 'completed');
    await sync();
    const withBlock = github.pull.body;
    github.pull.state = 'closed';
    assert.equal(await sync(), 'removed', 'the removal is recorded as a write');
    github.pull.state = 'open';
    clock = new Date('2026-11-13T09:05:00Z');
    assert.equal(await sync(), 'updated', 'the reopened pull request gets its block back');
    const restored = github.pull.body;
    github.pull.body = HUMAN_BODY;
    await asWebhookProcess(async signalled => {
        // The earlier removal must not vouch for this deletion; seen through Redis alone as well.
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook(restored), 'pull_request'), 'foreign');
        resetPullRequestStatusProvenanceForTests();
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook(restored), 'pull_request'), 'foreign');
        assert.deepEqual(await processWebhookEvent(editedWebhook(restored), 'pull_request', 'corr-1'),
            { status: 'accepted', reason: 'pull_request_status_block_edited', billing: { seatConsumed: false } });
        assert.deepEqual(signalled, [[REPOSITORY, PR]]);
    });
    assert.notEqual(withBlock, restored);
    assert.equal(await sync(), 'updated');
    assert.match(statusLine(), /✅ Ready/);
    assert.equal(stripPullRequestStatusBlock(github.pull.body), HUMAN_BODY);
});

test('a person putting back an earlier block ProPR wrote gets the current status reconciled', async () => {
    const review = await addTask('issue', 'processing');
    await sync();
    const earlier = github.pull.body;
    assert.doesNotMatch(statusLine(), /✅ Ready/);
    await setTaskState(review, 'completed');
    clock = new Date('2026-11-13T09:05:00Z');
    assert.equal(await sync(), 'updated');
    const current = github.pull.body;
    assert.match(statusLine(), /✅ Ready/);
    github.pull.body = earlier;
    await asWebhookProcess(async signalled => {
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook(current), 'pull_request'), 'foreign');
        resetPullRequestStatusProvenanceForTests();
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook(current), 'pull_request'), 'foreign');
        await processWebhookEvent(editedWebhook(current), 'pull_request', 'corr-1');
        assert.deepEqual(signalled, [[REPOSITORY, PR]], 'the outdated status is not left standing');
    });
    assert.equal(await sync(), 'updated');
    assert.match(statusLine(), /✅ Ready/);
});

/** Records, in this process only, that ProPR left the block of `body` (none here). */
async function recordWriteFor(body: string): Promise<void> {
    await recordPullRequestStatusWrite(null, REPOSITORY, PR, extractPullRequestStatusBlock(body));
}

test('a recorded write stops counting once it expires, in this process too', async (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T09:00:00Z') });
    await recordWriteFor(HUMAN_BODY);
    assert.equal(await isRecordedPullRequestStatusWrite(null, REPOSITORY, PR, HUMAN_BODY), true);
    context.mock.timers.tick(6 * 60 * 60 * 1000);
    assert.equal(await isRecordedPullRequestStatusWrite(null, REPOSITORY, PR, HUMAN_BODY), false);
});

test('the write is recorded before the PATCH, and a browser edit of the same block still matches', async () => {
    await addTask('issue', 'completed');
    const request = github.request.bind(github);
    let recordedAtPatch: boolean | null = null;
    github.request = (async (route: string, params: Record<string, unknown>) => {
        if (route.startsWith('PATCH ')) {
            // Seen from another process: only the record shared through Redis counts.
            resetPullRequestStatusProvenanceForTests();
            recordedAtPatch = await isRecordedPullRequestStatusWrite(redis as never, REPOSITORY, PR, params.body as string);
        }
        return await request(route, params);
    }) as typeof github.request;
    try {
        assert.equal(await sync(), 'updated');
    } finally {
        github.request = request;
    }
    assert.equal(recordedAtPatch, true, 'the webhook of the write can never arrive before its record');
    assert.equal(await isRecordedPullRequestStatusWrite(redis as never, REPOSITORY, PR, github.pull.body.replace(/\n/g, '\r\n')), true);
    assert.equal(await isRecordedPullRequestStatusWrite(redis as never, REPOSITORY, PR, github.pull.body.replace('updated', 'edited')), false);
    assert.equal(await isRecordedPullRequestStatusWrite(redis as never, REPOSITORY, PR, HUMAN_BODY), false, 'a removal ProPR never made');

    // Without status maintenance in this process there is no record to consult: the edit is not ProPR's own.
    resetPullRequestStatusProvenanceForTests();
    assert.equal(await classifyPullRequestStatusEdit(editedWebhook(HUMAN_BODY, 'propr[bot]'), 'pull_request'), 'foreign');
    assert.equal(await classifyPullRequestStatusEdit({ ...editedWebhook(HUMAN_BODY), pull_request: { number: PR, body: `${github.pull.body}\nmore` } }, 'pull_request'), null, 'not a block-only edit');
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

// --- Unavailable facts (F5) ---

async function assertUnavailableKeepsBlock(breakRead: () => Promise<void> | void, label: string): Promise<void> {
    await sync();
    const before = github.pull.body;
    assert.match(statusLine(), /⚠️ Needs you · review below goal|🔨 Ultrafix|🔨 Queued/, `${label}: baseline`);
    await breakRead();
    await assert.rejects(loadPullRequestStatusFacts(REPOSITORY, PR, { ...deps().sources!, github }), undefined, `${label}: the read failure is not erased`);
    await assert.rejects(sync(), undefined, `${label}: the sync fails instead of computing a status`);
    assert.equal(github.pull.body, before, `${label}: the previous block is kept, never replaced by Ready`);
}

test('a review score that cannot be read never turns a reviewed pull request ready', async () => {
    await addTask('issue', 'completed');
    await database('review_scores').insert({ repository_id: REPOSITORY, pr_number: PR, score: 5, created_at: '2026-11-13T09:10:00Z' });
    try {
        await assertUnavailableKeepsBlock(() => database.schema.renameTable('review_scores', 'review_scores_offline'), 'review');
    } finally {
        await database.schema.renameTable('review_scores_offline', 'review_scores');
    }
});

test('an Ultrafix state that cannot be read never turns an active loop ready', async () => {
    await addTask('issue', 'completed');
    redis.values.set(`ultrafix:state:integry:propr:${PR}`, JSON.stringify({ goal: 7, maxCycles: 5, cycleCount: 1, active: true }));
    const get = redis.get.bind(redis);
    await assertUnavailableKeepsBlock(() => {
        redis.get = async (key: string) => {
            if (key.startsWith('ultrafix:')) throw new Error('redis unavailable');
            return await get(key);
        };
    }, 'ultrafix');
});

test('queued work that cannot be counted never reads ready', async () => {
    await addTask('issue', 'completed');
    let failing = false;
    const queued = async () => { if (failing) throw new Error('queue unavailable'); return 1; };
    const sources = deps().sources!;
    const withQueue = (): Partial<PullRequestStatusSyncDeps> => ({ ...deps(), sources: { ...sources, countQueuedJobs: queued } });
    await syncPullRequestStatus(REPOSITORY, PR, withQueue());
    assert.match(statusLine(), /🔨 Queued/);
    const before = github.pull.body;
    failing = true;
    await assert.rejects(loadPullRequestStatusFacts(REPOSITORY, PR, { ...sources, countQueuedJobs: queued, github }));
    await assert.rejects(syncPullRequestStatus(REPOSITORY, PR, withQueue()));
    assert.equal(github.pull.body, before);
});

// --- Unknown mergeability (F6) ---

test('unknown mergeability is not ready, and the status is refreshed until GitHub settles it', async () => {
    await addTask('issue', 'completed');
    github.pull.mergeable = null;
    assert.equal(await sync(), 'updated');
    assert.match(statusLine(), /🔨 Checking for conflicts · checks: 1 passed/);
    assert.doesNotMatch(statusLine(), /Ready/);

    setPullRequestStatusMergeabilityRefreshDelaysForTests([20, 20, 20]);
    enablePullRequestStatusSync(deps());
    // One facts read per sync: the pull request itself is read before and after it.
    const reads = () => github.calls.filter(call => call.route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs').length;
    const waitFor = async (condition: () => boolean) => {
        const deadline = Date.now() + 8_000;
        while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    };
    try {
        // GitHub resolves to a conflict after the first read: the refresh, not a webhook, settles the block.
        const start = reads();
        requestPullRequestStatusSync(REPOSITORY, PR);
        await waitFor(() => reads() >= start + 2);
        github.pull.mergeable = false;
        await waitFor(() => /conflicts with base/.test(statusLine()));
        assert.match(statusLine(), /⚠️ Needs you · conflicts with base/);

        // While mergeability stays unknown, refreshes stop after the bounded schedule.
        github.pull.mergeable = null;
        const bounded = reads();
        requestPullRequestStatusSync(REPOSITORY, PR);
        await waitFor(() => reads() >= bounded + 4);
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(reads() - bounded, 4, 'one sync and three refreshes');
        assert.match(statusLine(), /🔨 Checking for conflicts/);
    } finally {
        disablePullRequestStatusSync();
        setPullRequestStatusMergeabilityRefreshDelaysForTests(null);
    }
});

// --- Body length (F7) ---

test('a body close to the limit gets the compact block, and none when even that does not fit', async () => {
    await addTask('issue', 'completed');
    await database('review_scores').insert({ repository_id: REPOSITORY, pr_number: PR, score: 8, created_at: '2026-11-13T09:10:00Z' });
    const filler = (room: number) => `${HUMAN_BODY}\n${'x'.repeat(PR_BODY_MAX_LENGTH - HUMAN_BODY.length - 1 - room)}`;

    github.pull.body = filler(100);
    const human = github.pull.body;
    assert.equal(await sync(), 'updated');
    assert.ok(github.pull.body.length <= PR_BODY_MAX_LENGTH);
    assert.equal(stripPullRequestStatusBlock(github.pull.body), human, 'the text outside the block is never shortened');
    assert.match(statusLine(), /^\*\*ProPR\*\* ✅ Ready · updated \d{2}:\d{2} UTC$/);

    github.pull.body = filler(10);
    const writes = github.writes().length;
    assert.equal(await sync(), 'skipped', 'no room for any block: nothing is written');
    assert.equal(github.writes().length, writes);

    // A person grows the description around an existing block until it no longer fits: the block is left out, not left stale.
    github.pull.body = `${extractPullRequestStatusBlock(`${(await initialBlock())!}`)}\n\n${filler(10)}`;
    assert.equal(await sync(), 'removed');
    assert.equal(github.pull.body, filler(10));
    assert.ok(github.patches.every(body => body.length <= PR_BODY_MAX_LENGTH));
});

test('another body writer near the limit keeps its text and drops the block rather than exceed the limit', async () => {
    await addTask('issue', 'completed');
    await sync();
    assert.ok(extractPullRequestStatusBlock(github.pull.body));
    const published = 'p'.repeat(PR_BODY_MAX_LENGTH - 20);
    await updatePullRequestBody(github as never, { owner: 'integry', repo: 'propr', pullNumber: PR, body: published }, { preserveStatusBlock: true, redis: redis as never });
    assert.equal(github.pull.body, published);
});

// --- Active work beyond the task history limit (F8) ---

test('an active task older than 20 newer terminal tasks still reads working, never ready', async () => {
    await addTask('issue', 'completed');
    await addTask('pr-comment', 'processing', { commandMode: 'follow_up' });
    for (let index = 0; index < 20; index++) await addTask('pr-comment', 'cancelled');
    const facts = await loadPullRequestStatusFacts(REPOSITORY, PR, { ...deps().sources!, github });
    assert.ok(facts.tasks.some(task => task.state === 'processing'), 'the active task is read');
    assert.equal(facts.tasks[0]?.state, 'cancelled', 'newest first, so the latest outcome is still the newest record');
    assert.equal(await sync(), 'updated');
    assert.match(statusLine(), /🔨 Follow-up in progress/);
    assert.doesNotMatch(statusLine(), /Ready/);
});

// --- Body lock lease (F9) ---

const LOCK_KEY = `propr:pr-status:lock:${REPOSITORY}#${PR}`;
const PREVIEW_BODY = `${HUMAN_BODY}\n\n<!-- propr:visual-preview -->\nNewer preview\n<!-- /propr:visual-preview -->`;
const fastLock = { ttlMs: 120, renewMs: 30, pollMs: 10, waitMs: 5_000 };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A status sync whose facts read stays outstanding until `release` is called. */
function slowStatusSync(): { done: Promise<string>; factsStarted: Promise<void>; release: () => void } {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const factsStarted = new Promise<void>(resolve => { started = resolve; });
    const base = deps();
    const done = syncPullRequestStatus(REPOSITORY, PR, {
        ...base, sources: { ...base.sources!, loadRatingGoal: async () => { started(); await gate; return 7; } },
    });
    return { done, factsStarted, release };
}

/** Another process's body writer (e.g. visual preview publication): read, then write under its own lock. */
async function otherProcessPublishesPreview(): Promise<void> {
    await otherProcessLock.withPullRequestBodyLock(REPOSITORY, PR, redis as never, async lease => {
        await github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: 'integry', repo: 'propr', pull_number: PR });
        await lease.assertHeld();
        await github.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner: 'integry', repo: 'propr', pull_number: PR, body: PREVIEW_BODY });
    });
}

function withFastLock(): void {
    setPullRequestBodyLockTimingForTests(fastLock);
    otherProcessLock.setPullRequestBodyLockTimingForTests(fastLock);
}

function restoreLock(): void {
    setPullRequestBodyLockTimingForTests(null);
    otherProcessLock.setPullRequestBodyLockTimingForTests(null);
}

test('the body lock is renewed while a slow status read runs, so another process waits for it', async () => {
    await addTask('issue', 'completed');
    withFastLock();
    try {
        const status = slowStatusSync();
        await status.factsStarted;
        const other = otherProcessPublishesPreview();
        await pause(fastLock.ttlMs * 4);
        assert.equal(github.patches.length, 0, 'the other writer is still waiting for the lock');
        status.release();
        assert.equal(await status.done, 'updated');
        await other;
        assert.equal(github.patches.length, 2);
        assert.ok(extractPullRequestStatusBlock(github.patches[0]), 'the status write came first');
        assert.equal(github.pull.body, PREVIEW_BODY, 'the newer writer read the status body and wrote after it');
    } finally {
        restoreLock();
    }
});

test('a status writer whose lock was taken over does not overwrite the newer body', async () => {
    await addTask('issue', 'completed');
    withFastLock();
    try {
        const status = slowStatusSync();
        await status.factsStarted;
        // The lease is gone (expired, or lost in a Redis failover) and another process takes the lock.
        await redis.del(LOCK_KEY);
        await otherProcessPublishesPreview();
        assert.equal(github.pull.body, PREVIEW_BODY);
        status.release();
        await assert.rejects(status.done, PullRequestBodyLockLostError);
        assert.equal(github.pull.body, PREVIEW_BODY, 'the stale read of the body is never written');
        assert.equal(github.patches.length, 1);

        // The retry re-reads the newer body and keeps the preview.
        assert.equal(await sync(), 'updated');
        assert.equal(stripPullRequestStatusBlock(github.pull.body), PREVIEW_BODY);
    } finally {
        restoreLock();
    }
});

test('a lease that lapses while renewals fail is not written through', async () => {
    await addTask('issue', 'completed');
    withFastLock();
    try {
        const status = slowStatusSync();
        await status.factsStarted;
        redis.failRenewals = true;
        await pause(fastLock.ttlMs * 3);
        redis.failRenewals = false;
        status.release();
        await assert.rejects(status.done, PullRequestBodyLockLostError);
        assert.equal(github.patches.length, 0);
        assert.equal(github.pull.body, HUMAN_BODY);
    } finally {
        restoreLock();
    }
});

test('another body writer whose lock was taken over does not overwrite the newer body', async () => {
    await addTask('issue', 'completed');
    await sync();
    withFastLock();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reading!: () => void;
    const readStarted = new Promise<void>(resolve => { reading = resolve; });
    // The writer's GitHub read stays outstanding past its lease.
    const slowGitHub = {
        request: async (route: string, params: Record<string, unknown>) => {
            if (route.startsWith('GET ')) { const response = await github.request(route, params); reading(); await gate; return response; }
            return await github.request(route, params);
        },
    };
    try {
        const published = `${HUMAN_BODY}\n\nStale writer`;
        const write = updatePullRequestBody(slowGitHub as never, { owner: 'integry', repo: 'propr', pullNumber: PR, body: published }, { preserveStatusBlock: true, redis: redis as never });
        await readStarted;
        await redis.del(LOCK_KEY);
        await otherProcessPublishesPreview();
        release();
        await assert.rejects(write, PullRequestBodyLockLostError);
        assert.equal(github.pull.body, PREVIEW_BODY);
    } finally {
        restoreLock();
    }
});

// --- Human edits during the facts read (F10) ---

test('a description edit saved while the status facts are read is kept', async () => {
    await addTask('issue', 'completed');
    const status = slowStatusSync();
    await status.factsStarted;
    // A person saves on GitHub, which takes no ProPR lock.
    const edited = `${HUMAN_BODY}\n\nA person edited this while the status was read.`;
    github.pull.body = edited;
    status.release();
    assert.equal(await status.done, 'updated');
    assert.equal(stripPullRequestStatusBlock(github.pull.body), edited, 'the edit survives the status write');
    assert.match(statusLine(), /✅ Ready/);
    assert.equal(github.patches.length, 1);
});

test('a block already current is not rewritten over an edit saved during the facts read', async () => {
    await addTask('issue', 'completed');
    await sync();
    const block = extractPullRequestStatusBlock(github.pull.body);
    const status = slowStatusSync();
    await status.factsStarted;
    const edited = `${block}\n\n${HUMAN_BODY}\n\nEdited during the read.`;
    github.pull.body = edited;
    status.release();
    assert.equal(await status.done, 'unchanged');
    assert.equal(github.pull.body, edited);
});

test('a push during the facts read reads them again for the new head before writing', async () => {
    await addTask('issue', 'completed');
    github.checkRuns = [];
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    let pushed = false;
    const base = deps();
    const result = await syncPullRequestStatus(REPOSITORY, PR, {
        ...base,
        sources: {
            ...base.sources!,
            loadRatingGoal: async () => {
                if (!pushed) {
                    pushed = true;
                    github.pull.head = { ...github.pull.head, sha: 'head-2' };
                    github.pull.body = `${HUMAN_BODY}\n\nEdited with the push.`;
                    github.checkRuns = [{ name: 'unit', status: 'in_progress', conclusion: null }];
                }
                return 7;
            },
        },
    });
    assert.equal(result, 'updated');
    const checkedRefs = github.calls.filter(call => call.route.endsWith('/check-runs')).map(call => call.params.ref);
    assert.deepEqual(checkedRefs, ['head-1', 'head-2'], 'the facts are read again for the new head');
    assert.match(statusLine(), /checks: 1 pending/);
    assert.doesNotMatch(statusLine(), /Ready/, 'the old head\'s checks never decide the new head');
    assert.equal(stripPullRequestStatusBlock(github.pull.body), `${HUMAN_BODY}\n\nEdited with the push.`);
});

// F13: a push to the base branch leaves state and head as they were but can make the pull request conflict.
test('a pull request that starts conflicting during the facts read is not written as ready', async () => {
    await addTask('issue', 'completed');
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    let conflicted = false;
    const base = deps();
    const result = await syncPullRequestStatus(REPOSITORY, PR, {
        ...base,
        sources: {
            ...base.sources!,
            loadRatingGoal: async () => {
                if (!conflicted) {
                    conflicted = true;
                    github.pull.mergeable = false;
                }
                return 7;
            },
        },
    });
    assert.equal(result, 'updated');
    assert.equal(github.calls.filter(call => call.route.endsWith('/check-runs')).length, 2, 'the facts are read again');
    assert.equal(github.pull.head.sha, 'head-1', 'the head did not move');
    assert.doesNotMatch(statusLine(), /Ready/);
    assert.match(statusLine(), /⚠️ Needs you · conflicts with base/);
    assert.equal(github.patches.length, 1);
});

for (const [label, change] of [
    ['base branch moves', (pull: FakePull) => { pull.base = { ...pull.base, sha: 'base-2' }; }],
    ['base branch is retargeted', (pull: FakePull) => { pull.base = { ref: 'release', sha: 'release-1' }; }],
    ['mergeability becomes unknown', (pull: FakePull) => { pull.mergeable = null; }],
] as const) {
    test(`a pull request whose ${label} during the facts read is read again before writing`, async () => {
        await addTask('issue', 'completed');
        github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
        let changed = false;
        const base = deps();
        await syncPullRequestStatus(REPOSITORY, PR, {
            ...base,
            sources: { ...base.sources!, loadRatingGoal: async () => { if (!changed) { changed = true; change(github.pull); } return 7; } },
        });
        assert.equal(github.calls.filter(call => call.route.endsWith('/check-runs')).length, 2, `${label}: the facts are read again`);
        if (github.pull.mergeable === null) assert.match(statusLine(), /🔨 Checking for conflicts/);
    });
}

test('a pull request merged during the facts read loses its block, and the latest body is kept', async () => {
    await addTask('issue', 'completed');
    await sync();
    const status = slowStatusSync();
    await status.factsStarted;
    const edited = `${github.pull.body}\n\nEdited before the merge.`;
    github.pull.body = edited;
    github.pull.state = 'closed';
    github.pull.merged = true;
    status.release();
    assert.equal(await status.done, 'removed');
    assert.equal(github.pull.body, stripPullRequestStatusBlock(edited));
});

test('a pull request that changes head on every read is left unwritten for a retry', async () => {
    await addTask('issue', 'completed');
    let sha = 1;
    const base = deps();
    const pushing = { ...base, sources: { ...base.sources!, loadRatingGoal: async () => { github.pull.head = { ...github.pull.head, sha: `head-${++sha}` }; return 7; } } };
    await assert.rejects(syncPullRequestStatus(REPOSITORY, PR, pushing), PullRequestChangedDuringStatusSyncError);
    assert.equal(github.writes().length, 0);
});

// --- Pull request ownership (F11) ---

const EPIC_BRANCH = '800-epic-short-name-x7y';

test('a person\'s pull request from an epic-shaped branch gets no block', async () => {
    github.pull.head = { ...github.pull.head, ref: EPIC_BRANCH };
    const facts = await loadPullRequestStatusFacts(REPOSITORY, PR, { ...deps().sources!, github });
    assert.equal(facts.isProprPullRequest, false);
    assert.equal((await loadPullRequestStatus(REPOSITORY, PR, { ...deps().sources!, github })).state, 'none', 'MCP reads none');
    assert.equal(await sync(), 'skipped');
    assert.equal(github.writes().length, 0);
    assert.equal(github.pull.body, HUMAN_BODY);
});

test('an epic-shaped branch whose plan recorded a different epic branch is not ProPR\'s', async () => {
    github.pull.head = { ...github.pull.head, ref: EPIC_BRANCH };
    await database('task_drafts').insert({ draft_id: 'draft-1', repository: REPOSITORY, context_config: JSON.stringify({ epicLabel: 'base-800-epic-short-name-abc' }) });
    await database('plan_issues').insert({ repository: REPOSITORY, issue_number: 800, draft_id: 'draft-1', status: 'open' });
    assert.equal(await sync(), 'skipped');
    assert.equal(github.writes().length, 0);
});

async function recordEpicPlan(): Promise<void> {
    await database('task_drafts').insert({ draft_id: 'draft-1', repository: REPOSITORY, context_config: JSON.stringify({ epicLabel: `base-${EPIC_BRANCH}` }) });
    await database('plan_issues').insert({ repository: REPOSITORY, issue_number: 800, draft_id: 'draft-1', status: 'merged' });
    await database('plan_issues').insert({ repository: REPOSITORY, issue_number: 801, draft_id: 'draft-1', status: 'open' });
}

test('an epic pull request whose branch ProPR recorded for its plan gets the block', async () => {
    github.pull.head = { ...github.pull.head, ref: EPIC_BRANCH, repo: { full_name: 'Integry/ProPR' } };
    await recordEpicPlan();
    assert.equal(await sync(), 'updated');
    assert.match(statusLine(), /⚠️ 1 of 2 issues merged · nothing in progress/, 'the counts come from the epic merge progress');
    assert.equal(stripPullRequestStatusBlock(github.pull.body), HUMAN_BODY);
});

// F12: ProPR creates epic branches in the repository itself; a fork's branch of the same name is not ProPR's.
for (const [label, repo] of [['a fork', { full_name: 'someone/propr' }], ['a deleted fork', null]] as const) {
    test(`a pull request from ${label} on the recorded epic branch name gets no block`, async () => {
        github.pull.head = { ...github.pull.head, ref: EPIC_BRANCH, repo };
        await recordEpicPlan();
        const facts = await loadPullRequestStatusFacts(REPOSITORY, PR, { ...deps().sources!, github });
        assert.equal(facts.isProprPullRequest, false);
        assert.equal((await loadPullRequestStatus(REPOSITORY, PR, { ...deps().sources!, github })).state, 'none', 'MCP reads none');
        assert.equal(await sync(), 'skipped');
        assert.equal(github.writes().length, 0);
        assert.equal(github.pull.body, HUMAN_BODY);
    });
}

test('a ProPR pull request from a fork on an epic branch name shows no epic progress', async () => {
    await addTask('issue', 'completed');
    github.pull.head = { ...github.pull.head, ref: EPIC_BRANCH, repo: { full_name: 'someone/propr' } };
    await recordEpicPlan();
    const facts = await loadPullRequestStatusFacts(REPOSITORY, PR, { ...deps().sources!, github });
    assert.equal(facts.isProprPullRequest, true, 'owned through its implementation task');
    assert.equal(facts.epic, null, 'the fork branch is not the recorded epic');
});

test('a scheduled update whose pull request kept changing runs again and writes', async () => {
    await addTask('issue', 'completed');
    let pushes = 3;
    const base = deps();
    enablePullRequestStatusSync({
        ...base,
        sources: { ...base.sources!, loadRatingGoal: async () => { if (pushes > 0) github.pull.head = { ...github.pull.head, sha: `head-push-${pushes--}` }; return 7; } },
    });
    try {
        requestPullRequestStatusSync(REPOSITORY, PR);
        const deadline = Date.now() + 8_000;
        while (github.patches.length === 0 && Date.now() < deadline) await pause(20);
        assert.equal(github.patches.length, 1, 'the retry wrote the block');
        assert.match(statusLine(), /✅ Ready/);
        assert.equal(stripPullRequestStatusBlock(github.pull.body), HUMAN_BODY);
    } finally {
        disablePullRequestStatusSync();
    }
});

// --- Base pushes (F14) and existing pull requests at startup (F15) ---

const pullReads = (prNumber = PR) => github.calls.filter(call => call.route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}' && call.params.pull_number === prNumber).length;
const listings = () => github.calls.filter(call => call.route === 'GET /repos/{owner}/{repo}/pulls').length;
const facts = () => github.calls.filter(call => call.route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs').length;
async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await pause(20);
}
const PUSHED_TIP = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const push = (ref: string, after: string, extra: Record<string, unknown> = {}) =>
    signalPullRequestStatusFromWebhook({ repository: { full_name: REPOSITORY }, ref, after, before: 'a1a1a1a1', ...extra }, 'push');
/** A person's open pull request into the same base, which must cost no status read. */
const humanPull = { number: 43, head: { sha: 'human-head', ref: 'someone-else', repo: { full_name: REPOSITORY } }, base: { ref: 'main', sha: 'base-1' } };

async function readyProprPullRequest(): Promise<void> {
    await addTask('issue', 'completed');
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    await sync();
    assert.match(statusLine(), /✅ Ready/);
}

test('a push to the base branch refreshes the ProPR pull requests into it, so one that now conflicts is not left ready', async () => {
    await readyProprPullRequest();
    github.listed = [{ number: PR, head: github.pull.head, base: github.pull.base }, humanPull];
    enablePullRequestStatusSync(deps());
    try {
        // Another pull request merges into main: GitHub now reports this one as conflicting, and its head is unchanged.
        github.pull.base = { ref: 'main', sha: PUSHED_TIP };
        github.pull.mergeable = false;
        github.listed = [{ number: PR, head: github.pull.head, base: github.pull.base }, { ...humanPull, base: github.pull.base }];
        push('refs/heads/main', PUSHED_TIP);
        push('refs/heads/main', PUSHED_TIP);
        await until(() => /conflicts with base/.test(statusLine()));
        assert.match(statusLine(), /⚠️ Needs you · conflicts with base/);
        assert.equal(stripPullRequestStatusBlock(github.pull.body), HUMAN_BODY);
        assert.equal(listings(), 1, 'a burst of pushes to one branch is one listing');
        assert.deepEqual(github.calls.filter(call => call.route === 'GET /repos/{owner}/{repo}/pulls').map(call => call.params.base), ['main']);
        assert.equal(pullReads(43), 0, 'a pull request ProPR did not create is never read for a status');
    } finally {
        disablePullRequestStatusSync();
    }
});

test('tags, deleted branches and rescue refs list no pull requests', async () => {
    await readyProprPullRequest();
    enablePullRequestStatusSync(deps());
    try {
        push('refs/tags/v1.0.0', PUSHED_TIP);
        push('refs/heads/main', '0000000000000000000000000000000000000000', { deleted: true });
        push('refs/heads/propr/rescue/task-1', PUSHED_TIP);
        await pause(1_300);
        assert.equal(listings(), 0);
    } finally {
        disablePullRequestStatusSync();
    }
});

test('a read from before GitHub compared the pull request with the pushed base is read again, within a bound', async () => {
    await readyProprPullRequest();
    setPullRequestStatusMergeabilityRefreshDelaysForTests([20, 20, 20, 20]);
    enablePullRequestStatusSync(deps());
    try {
        // GitHub has not yet compared the pull request with the new tip: the first read still reports the old base, mergeable.
        const start = facts();
        push('refs/heads/main', PUSHED_TIP);
        await until(() => facts() >= start + 1);
        assert.match(statusLine(), /✅ Ready/, 'the stale read changes nothing');
        github.pull.base = { ref: 'main', sha: PUSHED_TIP };
        github.pull.mergeable = false;
        await until(() => /conflicts with base/.test(statusLine()));
        assert.match(statusLine(), /⚠️ Needs you · conflicts with base/);
        // Settled: no further reads.
        const settled = facts();
        await pause(300);
        assert.equal(facts(), settled, 'reads stop once GitHub reports the pushed base');

        // A tip GitHub never reports comparing against stops after the bounded schedule.
        const bounded = facts();
        push('refs/heads/main', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3');
        await until(() => facts() >= bounded + 5);
        await pause(300);
        assert.equal(facts() - bounded, 5, 'one read and four refreshes');
    } finally {
        disablePullRequestStatusSync();
        setPullRequestStatusMergeabilityRefreshDelaysForTests(null);
    }
});

test('a failed listing of the pull requests into a pushed branch is retried', async () => {
    await readyProprPullRequest();
    setPullRequestStatusMergeabilityRefreshDelaysForTests([20, 20]);
    enablePullRequestStatusSync(deps());
    try {
        github.pull.base = { ref: 'main', sha: PUSHED_TIP };
        github.pull.mergeable = false;
        github.listFailures = 1;
        push('refs/heads/main', PUSHED_TIP);
        await until(() => /conflicts with base/.test(statusLine()));
        assert.match(statusLine(), /⚠️ Needs you · conflicts with base/);
        assert.equal(listings(), 2);
    } finally {
        disablePullRequestStatusSync();
        setPullRequestStatusMergeabilityRefreshDelaysForTests(null);
    }
});

test('an idle ProPR pull request that existed before startup gets its block from the startup backfill', async () => {
    await addTask('issue', 'completed');
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    github.listed = [{ number: PR, head: github.pull.head, base: github.pull.base }, humanPull];
    assert.equal(extractPullRequestStatusBlock(github.pull.body), null, 'deployed before the block existed');
    const listRepositories = async () => [REPOSITORY, REPOSITORY.toUpperCase(), ' integry/propr ', 'not a repository'];
    enablePullRequestStatusSync({ ...deps(), listRepositories }, { backfill: true });
    try {
        await until(() => /✅ Ready/.test(statusLine()));
        assert.match(statusLine(), /✅ Ready · checks: 1 passed/);
        assert.equal(stripPullRequestStatusBlock(github.pull.body), HUMAN_BODY);
        assert.equal(listings(), 1, 'each monitored repository is listed once');
        assert.equal(pullReads(43), 0, 'a pull request ProPR did not create is never read for a status');
        // Enabling again in the same process does not repeat the backfill.
        enablePullRequestStatusSync({ ...deps(), listRepositories }, { backfill: true });
        await pause(1_300);
        assert.equal(listings(), 1);
    } finally {
        disablePullRequestStatusSync();
    }
});

test('status maintenance without the backfill option lists no pull requests', async () => {
    await addTask('issue', 'completed');
    enablePullRequestStatusSync({ ...deps(), listRepositories: async () => [REPOSITORY] });
    try {
        await pause(1_300);
        assert.equal(listings(), 0);
        assert.equal(github.patches.length, 0);
    } finally {
        disablePullRequestStatusSync();
    }
});

test('a repository whose open pull requests cannot be listed at startup is listed again', async () => {
    await addTask('issue', 'completed');
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    github.listFailures = 1;
    setPullRequestStatusMergeabilityRefreshDelaysForTests([20, 20]);
    enablePullRequestStatusSync({ ...deps(), listRepositories: async () => [REPOSITORY] }, { backfill: true });
    try {
        await until(() => /✅ Ready/.test(statusLine()));
        assert.match(statusLine(), /✅ Ready/);
        assert.equal(listings(), 2);
    } finally {
        disablePullRequestStatusSync();
        setPullRequestStatusMergeabilityRefreshDelaysForTests(null);
    }
});

test('a backfilled update that fails is retried, since no transition may follow', async () => {
    await addTask('issue', 'completed');
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    let failures = 1;
    const base = deps();
    setPullRequestStatusMergeabilityRefreshDelaysForTests([20, 20]);
    enablePullRequestStatusSync({
        ...base, listRepositories: async () => [REPOSITORY],
        sources: { ...base.sources!, loadRatingGoal: async () => { if (failures-- > 0) throw new Error('config unavailable'); return 7; } },
    }, { backfill: true });
    try {
        await until(() => /✅ Ready/.test(statusLine()));
        assert.match(statusLine(), /✅ Ready/);
    } finally {
        disablePullRequestStatusSync();
        setPullRequestStatusMergeabilityRefreshDelaysForTests(null);
    }
});

// --- Reconciliation retries after a rejected check read (F21) ---

const statusReads = () => github.calls.filter(call => call.route === 'GET /repos/{owner}/{repo}/commits/{ref}/status').length;

test('a backfilled update whose check read rejected is retried, so the block does not stay at "checks could not be read"', async () => {
    await addTask('issue', 'completed');
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    github.checkFailures = 1;
    setPullRequestStatusMergeabilityRefreshDelaysForTests([20, 20]);
    enablePullRequestStatusSync({ ...deps(), listRepositories: async () => [REPOSITORY] }, { backfill: true });
    try {
        await until(() => /✅ Ready/.test(statusLine()));
        assert.match(statusLine(), /✅ Ready · checks: 1 passed/);
        assert.ok(github.patches.some(body => /checks could not be read/.test(body)), 'the rejected read was written, then refreshed');
        assert.equal(facts(), 2, 'one read rejected, the retry read the checks');
        const settled = facts();
        await pause(300);
        assert.equal(facts(), settled, 'a complete read ends the retries');
    } finally {
        disablePullRequestStatusSync();
        setPullRequestStatusMergeabilityRefreshDelaysForTests(null);
    }
});

test('a base-push refresh whose check read rejected is retried', async () => {
    await readyProprPullRequest();
    setPullRequestStatusMergeabilityRefreshDelaysForTests([20, 20]);
    enablePullRequestStatusSync(deps());
    try {
        github.pull.base = { ref: 'main', sha: PUSHED_TIP };
        github.checkRuns = [{ name: 'unit', status: 'completed', conclusion: 'failure' }];
        github.checkFailures = 1;
        const start = statusReads();
        push('refs/heads/main', PUSHED_TIP);
        await until(() => /unit/.test(statusLine()));
        assert.match(statusLine(), /⚠️ Needs you · failed: unit/);
        assert.equal(statusReads() - start, 2, 'the rejected read was retried once GitHub had reported the pushed base');
    } finally {
        disablePullRequestStatusSync();
        setPullRequestStatusMergeabilityRefreshDelaysForTests(null);
    }
});

test('checks left unread by the page budget are not retried: the limit is not a transient failure', async () => {
    await addTask('issue', 'completed');
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    github.checkRuns = Array.from({ length: 301 }, (_, index) => ({ name: `unit-${index}`, status: 'completed', conclusion: 'success' }));
    setPullRequestStatusMergeabilityRefreshDelaysForTests([20, 20]);
    enablePullRequestStatusSync({ ...deps(), listRepositories: async () => [REPOSITORY] }, { backfill: true });
    try {
        await until(() => /checks could not be read/.test(statusLine()));
        assert.match(statusLine(), /⚠️ Needs you · checks could not be read/);
        await pause(300);
        assert.equal(facts(), 3, 'the three budgeted pages of the one read, and no refresh');
    } finally {
        disablePullRequestStatusSync();
        setPullRequestStatusMergeabilityRefreshDelaysForTests(null);
    }
});

const openPulls = (numbers: number[]) => numbers.map(number => ({ number, head: { sha: `h${number}`, ref: `b${number}`, repo: { full_name: REPOSITORY } }, base: { ref: 'main', sha: 'base-1' } }));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
async function ownPullRequests(numbers: number[], state: string | null = null): Promise<void> {
    for (const prNumber of numbers) {
        await database('tasks').insert({ task_id: `owned-${prNumber}`, repository: REPOSITORY, issue_number: prNumber + 1000, task_type: 'issue', created_at: '2026-11-13T08:00:00Z', initial_job_data: '{}', pr_number: prNumber });
        if (state) await database('task_history').insert({ task_id: `owned-${prNumber}`, state });
    }
}
function recordingReconcileDeps() {
    const scheduled: Array<[string, number, PullRequestStatusScheduleOptions]> = [];
    // The other repositories have no open pull requests.
    const listing = { request: async (route: string, params: Record<string, unknown>) => (params.repo === 'propr' ? await github.request(route, params) : (github.calls.push({ route, params }), { data: [] })) };
    const reconcileDeps = { github: listing, db: database, spacingMs: 100, schedule: (repository: string, prNumber: number, options: PullRequestStatusScheduleOptions) => { scheduled.push([repository, prNumber, options]); } };
    return { scheduled, reconcileDeps };
}
const listedPages = (repo = 'propr') => github.calls.filter(call => call.params.repo === repo && call.route === 'GET /repos/{owner}/{repo}/pulls').map(call => call.params.page);

test('the backfill and the base fan-out read in bounded batches, and resume where a batch stopped until every pull request is listed', async () => {
    // 350 open pull requests: one batch reads three pages; ProPR created 10, 150 and 320.
    await ownPullRequests([10, 150, 320]);
    github.listed = openPulls(range(1, 350));
    const { scheduled, reconcileDeps } = recordingReconcileDeps();

    const repositories = [REPOSITORY, ...Array.from({ length: MAX_STATUS_BACKFILL_REPOSITORIES + 5 }, (_, index) => `integry/other-${index}`)];
    const first = await schedulePullRequestStatusBackfill({ ...reconcileDeps, listRepositories: async () => repositories });
    assert.equal(first.repositories, MAX_STATUS_BACKFILL_REPOSITORIES);
    assert.equal(new Set(github.calls.filter(call => call.route === 'GET /repos/{owner}/{repo}/pulls').map(call => call.params.repo)).size, MAX_STATUS_BACKFILL_REPOSITORIES);
    assert.deepEqual(listedPages(), [1, 2, 3]);
    assert.deepEqual(scheduled, [[REPOSITORY, 10, { reconcile: true, delayMs: 0 }], [REPOSITORY, 150, { reconcile: true, delayMs: 100 }]]);
    assert.deepEqual(first.failed, []);
    // Deferred, not dropped: the repositories past the batch, then the rest of the cut-short listing.
    assert.deepEqual(first.remaining, [
        ...repositories.slice(MAX_STATUS_BACKFILL_REPOSITORIES).map(repository => ({ repository, from: null })),
        { repository: REPOSITORY, from: { page: 3, after: 300 } },
    ]);
    assert.ok(first.resumeAfterMs >= 2 * 100, 'the next batch starts after this one\'s updates have');

    github.calls.length = 0;
    scheduled.length = 0;
    const second = await schedulePullRequestStatusBackfill({ ...reconcileDeps, listRepositories: async () => { throw new Error('the work is not listed again'); } }, first.remaining);
    assert.equal(second.repositories, repositories.length - MAX_STATUS_BACKFILL_REPOSITORIES + 1);
    assert.deepEqual(listedPages(), [3, 4]);
    assert.deepEqual(scheduled, [[REPOSITORY, 320, { reconcile: true, delayMs: 0 }]]);
    assert.deepEqual(second.remaining, []);
    assert.deepEqual(second.failed, []);

    github.calls.length = 0;
    scheduled.length = 0;
    const firstPush = await schedulePullRequestStatusForBasePush(reconcileDeps, { repository: REPOSITORY, branch: 'main', sha: PUSHED_TIP });
    assert.deepEqual(firstPush.scheduled, [10, 150]);
    assert.deepEqual(firstPush.next, { page: 3, after: 300 });
    assert.deepEqual(scheduled, [[REPOSITORY, 10, { baseSha: PUSHED_TIP, delayMs: 0 }], [REPOSITORY, 150, { baseSha: PUSHED_TIP, delayMs: 100 }]]);
    scheduled.length = 0;
    const secondPush = await schedulePullRequestStatusForBasePush(reconcileDeps, { repository: REPOSITORY, branch: 'main', sha: PUSHED_TIP, from: firstPush.next });
    assert.deepEqual(secondPush.scheduled, [320]);
    assert.equal(secondPush.next, null);
    assert.deepEqual(scheduled, [[REPOSITORY, 320, { baseSha: PUSHED_TIP, delayMs: 0 }]]);
    assert.deepEqual(github.calls.filter(call => call.route === 'GET /repos/{owner}/{repo}/pulls').map(call => call.params.base), ['main', 'main', 'main', 'main', 'main']);
});

test('a resumed listing finds its place again when pull requests before it closed between batches', async () => {
    await ownPullRequests([303, 320]);
    const { reconcileDeps } = recordingReconcileDeps();
    const target = { repository: REPOSITORY, branch: 'main', sha: PUSHED_TIP };
    github.listed = openPulls(range(1, 350));
    const first = await schedulePullRequestStatusForBasePush(reconcileDeps, target);
    assert.deepEqual(first.next, { page: 3, after: 300 });

    // Five earlier pull requests close: #301-#305 move onto page 3, which the next batch reads again.
    github.listed = openPulls(range(6, 350));
    github.calls.length = 0;
    const few = await schedulePullRequestStatusForBasePush(reconcileDeps, { ...target, from: first.next });
    assert.deepEqual(few.scheduled, [303, 320]);
    assert.equal(few.next, null);
    assert.deepEqual(listedPages(), [3, 4]);

    // 150 close, more than a page: the listing steps back to the page that holds its cursor.
    github.listed = openPulls(range(151, 350));
    github.calls.length = 0;
    const many = await schedulePullRequestStatusForBasePush(reconcileDeps, { ...target, from: first.next });
    assert.deepEqual(many.scheduled, [303, 320]);
    assert.equal(many.next, null);
    assert.deepEqual(listedPages(), [3, 2, 3]);

    // 250 close: stepping back takes the whole batch, and the next one goes on from where it got to.
    github.listed = openPulls(range(251, 350));
    github.calls.length = 0;
    const most = await schedulePullRequestStatusForBasePush(reconcileDeps, { ...target, from: first.next });
    assert.deepEqual(listedPages(), [3, 2, 1]);
    assert.deepEqual(most.scheduled, [303, 320]);
    assert.deepEqual(most.next, { page: 1, after: 350 });
    const rest = await schedulePullRequestStatusForBasePush(reconcileDeps, { ...target, from: most.next });
    assert.deepEqual(rest.scheduled, []);
    assert.equal(rest.next, null);
});

test('an idle ProPR pull request past the first batch of a large repository gets its block from the startup backfill', async () => {
    await ownPullRequests([320], 'completed');
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    github.listed = openPulls(range(1, 350));
    enablePullRequestStatusSync({ ...deps(), listRepositories: async () => [REPOSITORY] }, { backfill: true });
    try {
        await until(() => /✅ Ready/.test(statusLine()), 10_000);
        assert.match(statusLine(), /✅ Ready/);
        assert.ok(pullReads(320) > 0, 'the pull request on the fourth page is updated');
        assert.deepEqual(listedPages(), [1, 2, 3, 3, 4]);
        await pause(300);
        assert.equal(listings(), 5, 'the backfill ends once every page is listed');
    } finally {
        disablePullRequestStatusSync();
    }
});

test('a push to a base with more open pull requests than one batch reaches the ProPR pull requests past it', async () => {
    await ownPullRequests([320], 'completed');
    github.commitStatus = { state: 'success', total_count: 0, statuses: [] };
    github.listed = openPulls(range(1, 350));
    await syncPullRequestStatus(REPOSITORY, 320, deps());
    assert.match(statusLine(), /✅ Ready/);
    enablePullRequestStatusSync(deps());
    try {
        github.pull.base = { ref: 'main', sha: PUSHED_TIP };
        github.pull.mergeable = false;
        push('refs/heads/main', PUSHED_TIP);
        await until(() => /conflicts with base/.test(statusLine()), 10_000);
        assert.match(statusLine(), /⚠️ Needs you · conflicts with base/);
        assert.deepEqual(listedPages(), [1, 2, 3, 3, 4]);
    } finally {
        disablePullRequestStatusSync();
    }
});

// --- check loader: legacy commit statuses (F19) ---

function checkSources(commitStatus: FakeGitHub['commitStatus'], checkRuns: Array<{ name: string; status: string; conclusion: string | null }> = [], patterns: string[] = []) {
    return {
        github: {
            request: async (route: string, params: Record<string, unknown>) => {
                if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') return { data: { total_count: checkRuns.length, check_runs: checkRuns } };
                if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/status') return { data: pagedCommitStatus(commitStatus, params) };
                throw new Error(`unexpected ${route}`);
            },
        },
        loadNonBlockingChecks: async () => patterns,
    };
}

test('a failed and a pending legacy context are one failed and one pending, never a passed', async () => {
    const checks = await loadPullRequestStatusChecks(checkSources({
        state: 'failure', total_count: 2,
        statuses: [{ context: 'ci/lint', state: 'failure' }, { context: 'ci/build', state: 'pending' }],
    }), 'acme', 'widgets', 'abc');
    assert.deepEqual(checks, { complete: true, readFailed: false, passed: 0, failed: 1, pending: 1, failedNames: ['ci/lint'] });
});

test('each listed legacy context counts on its own alongside check runs', async () => {
    const checks = await loadPullRequestStatusChecks(checkSources(
        { state: 'failure', total_count: 3, statuses: [{ context: 'ci/lint', state: 'error' }, { context: 'ci/build', state: 'pending' }, { context: 'ci/docs', state: 'success' }] },
        [{ name: 'unit', status: 'completed', conclusion: 'success' }, { name: 'e2e', status: 'in_progress', conclusion: null }],
    ), 'acme', 'widgets', 'abc');
    assert.deepEqual(checks, { complete: true, readFailed: false, passed: 2, failed: 1, pending: 2, failedNames: ['ci/lint'] });
});

test('a non-blocking legacy context neither fails nor holds the status, and does not count as passed', async () => {
    const checks = await loadPullRequestStatusChecks(checkSources(
        { state: 'failure', total_count: 3, statuses: [{ context: 'ci/lint', state: 'failure' }, { context: 'ci/build', state: 'pending' }, { context: 'coverage/optional', state: 'failure' }] },
        [], ['coverage/*'],
    ), 'acme', 'widgets', 'abc');
    assert.deepEqual(checks, { complete: true, readFailed: false, passed: 0, failed: 1, pending: 1, failedNames: ['ci/lint'] });
});

// --- check loader: legacy contexts beyond one page (F20) ---

const legacyContexts = (count: number, state = 'success', prefix = 'ci/ok') => Array.from({ length: count }, (_, index) => ({ context: `${prefix}-${index}`, state }));
const checkReads = (calls: string[], route: string) => calls.filter(call => call === route).length;

test('legacy contexts beyond the first page are read, so a pending context is never counted as passed', async () => {
    // 101 blocking contexts: one failed, one pending, 99 successful. One page of 100 leaves one unlisted.
    const sources = checkSources({
        state: 'failure', total_count: 101,
        statuses: [{ context: 'ci/lint', state: 'failure' }, { context: 'ci/build', state: 'pending' }, ...legacyContexts(99)],
    });
    const routes: string[] = [];
    const request = sources.github.request;
    sources.github.request = async (route: string, params: Record<string, unknown>) => { routes.push(route); return await request(route, params); };
    const checks = await loadPullRequestStatusChecks(sources, 'acme', 'widgets', 'abc');
    assert.deepEqual(checks, { complete: true, readFailed: false, passed: 99, failed: 1, pending: 1, failedNames: ['ci/lint'] });
    assert.equal(checkReads(routes, 'GET /repos/{owner}/{repo}/commits/{ref}/status'), 2, 'two pages list every context');
});

test('legacy contexts past the page budget keep their known states, and the unread ones are neither passed nor pending', async () => {
    const listed = [{ context: 'ci/lint', state: 'failure' }, { context: 'ci/build', state: 'pending' }, ...legacyContexts(298)];
    const checks = await loadPullRequestStatusChecks(checkSources({
        state: 'failure', total_count: 301, statuses: [...listed, { context: 'ci/unread', state: 'pending' }],
    }), 'acme', 'widgets', 'abc');
    assert.deepEqual(checks, { complete: false, readFailed: false, passed: 298, failed: 1, pending: 1, failedNames: ['ci/lint'] });
});

test('a combined state no listed legacy context accounts for is an unlisted context, never a pass', async () => {
    // total_count says 3 contexts exist but only 2 came back, both successful:
    // the combined failure is the unlisted one's, and the pass count covers the listed successes only.
    const failed = await loadPullRequestStatusChecks(checkSources({
        state: 'failure', total_count: 3,
        statuses: [{ context: 'ci/lint', state: 'success' }, { context: 'ci/build', state: 'success' }],
    }), 'acme', 'widgets', 'abc');
    assert.deepEqual(failed, { complete: false, readFailed: false, passed: 2, failed: 1, pending: 0, failedNames: ['commit status'] });

    // A listed failure accounts for the combined failure: the unlisted context is only unread.
    const accounted = await loadPullRequestStatusChecks(checkSources({
        state: 'failure', total_count: 3,
        statuses: [{ context: 'ci/lint', state: 'failure' }, { context: 'ci/build', state: 'success' }],
    }), 'acme', 'widgets', 'abc');
    assert.deepEqual(accounted, { complete: false, readFailed: false, passed: 1, failed: 1, pending: 0, failedNames: ['ci/lint'] });

    const pending = await loadPullRequestStatusChecks(checkSources({ state: 'pending', total_count: 2, statuses: [] }), 'acme', 'widgets', 'abc');
    assert.deepEqual(pending, { complete: false, readFailed: false, passed: 0, failed: 0, pending: 1, failedNames: [] });
});

test('a rejected check read is incomplete and marked as a failed read; the page budget is not', async () => {
    const rejecting = checkSources({ state: 'success', total_count: 0, statuses: [] }, [{ name: 'unit', status: 'completed', conclusion: 'success' }]);
    const request = rejecting.github.request;
    rejecting.github.request = async (route: string, params: Record<string, unknown>) => {
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/status') throw new Error('GitHub unavailable');
        return await request(route, params);
    };
    const failed = await loadPullRequestStatusChecks(rejecting, 'acme', 'widgets', 'abc');
    assert.deepEqual(failed, { complete: false, readFailed: true, passed: 1, failed: 0, pending: 0, failedNames: [] });

    const budget = await loadPullRequestStatusChecks(checkSources({ state: 'success', total_count: 301, statuses: legacyContexts(301) }), 'acme', 'widgets', 'abc');
    assert.deepEqual(budget, { complete: false, readFailed: false, passed: 300, failed: 0, pending: 0, failedNames: [] });
});
