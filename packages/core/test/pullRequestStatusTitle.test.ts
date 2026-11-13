import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import knexFactory, { type Knex } from 'knex';
import type { PullRequestStatusSyncDeps } from '../src/services/pullRequestStatus/pullRequestStatusSync.js';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../src/db/connection.js');
const { disablePullRequestStatusSync, enablePullRequestStatusSync, syncPullRequestStatus } = await import('../src/services/pullRequestStatus/pullRequestStatusSync.js');
const { setPullRequestStatusSyncRunner } = await import('../src/services/pullRequestStatus/pullRequestStatusSignal.js');
const { resetPullRequestStatusProvenanceForTests } = await import('../src/services/pullRequestStatus/pullRequestStatusProvenance.js');
const {
    initialPullRequestTitle, resetPullRequestTitleStateForTests, setPullRequestTitleSettleMsForTests,
} = await import('../src/services/pullRequestStatus/pullRequestStatusTitle.js');
const { classifyPullRequestStatusEdit } = await import('../src/webhook/pullRequestStatusWebhook.js');
const { processWebhookEvent } = await import('../src/webhook/webhookHandler.js');
const { isEpicPullRequestTitle } = await import('../src/webhook/planIssueTracking.js');

const REPOSITORY = 'integry/propr';
const PR = 42;
const TITLE = '[12 by Claude Opus 5.5] Let an automation run when a plan issue is blocked';
const SETTLE_MS = 40;

class FakeRedis {
    values = new Map<string, string>();
    async get(key: string) { return this.values.get(key) ?? null; }
    async set(key: string, value: string, ...args: unknown[]) {
        if (args.includes('NX') && this.values.has(key)) return null;
        this.values.set(key, value);
        return 'OK';
    }
    async del(key: string) { return this.values.delete(key) ? 1 : 0; }
    async eval(script: string, _keys: number, key: string, token: string) {
        if (this.values.get(key) !== token) return 0;
        if (!script.includes('pexpire')) this.values.delete(key);
        return 1;
    }
}

class FakeGitHub {
    pull = {
        state: 'open', merged: false, mergeable: true as boolean | null, body: 'Implementation summary.', title: `🔨 ${TITLE}`,
        head: { sha: 'head-1', ref: '12-feature', repo: { full_name: REPOSITORY } }, base: { ref: 'main', sha: 'base-1' },
    };
    checkRuns: Array<{ name: string; status: string; conclusion: string | null }> = [{ name: 'unit', status: 'completed', conclusion: 'success' }];
    calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    /** Every title the pull request was renamed to. */
    renames: string[] = [];
    /** PATCH requests still to reject without applying them. */
    rejectPatches = 0;
    /** Runs when a PATCH arrives, before it is applied or rejected. */
    onPatch: (() => Promise<void>) | null = null;
    async request(route: string, params: Record<string, unknown>) {
        this.calls.push({ route, params });
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: structuredClone(this.pull) };
        if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') {
            await this.onPatch?.();
            if (this.rejectPatches > 0) {
                this.rejectPatches--;
                throw Object.assign(new Error('Validation Failed'), { status: 422 });
            }
            if (typeof params.body === 'string') this.pull.body = params.body;
            if (typeof params.title === 'string') {
                this.pull.title = params.title;
                this.renames.push(params.title);
            }
            return { data: structuredClone(this.pull) };
        }
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') return { data: { total_count: this.checkRuns.length, check_runs: this.checkRuns } };
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/status') return { data: { state: 'pending', total_count: 0, statuses: [] } };
        throw new Error(`unexpected route ${route}`);
    }
    writes() { return this.calls.filter(call => !call.route.startsWith('GET ')); }
}

let database: Knex;
let github: FakeGitHub;
let redis: FakeRedis;
let setting: boolean | Error;
let queuedJobs: number;

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
    await database.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); table.string('repository'); table.json('context_config'); });
    await database.schema.createTable('goals', table => { table.string('goal_id'); table.string('repository'); table.integer('final_pr_number'); });
    await database.schema.createTable('review_scores', table => {
        table.increments('id'); table.string('repository_id'); table.integer('pr_number'); table.integer('score'); table.string('created_at');
    });
    setPullRequestTitleSettleMsForTests(SETTLE_MS);
});

after(async () => {
    setPullRequestTitleSettleMsForTests(null);
    await database.destroy();
    await closeConnection();
});

beforeEach(async () => {
    for (const name of ['tasks', 'task_history', 'plan_issues', 'task_drafts', 'goals', 'review_scores']) await database(name).del();
    github = new FakeGitHub();
    redis = new FakeRedis();
    setting = true;
    queuedJobs = 0;
    resetPullRequestStatusProvenanceForTests();
    resetPullRequestTitleStateForTests();
});

function deps(): Partial<PullRequestStatusSyncDeps> {
    return {
        github,
        redis: redis as never,
        sources: {
            db: database,
            redis: redis as never,
            loadRatingGoal: async () => 7,
            loadNonBlockingChecks: async () => [],
            countQueuedJobs: async () => queuedJobs,
        },
        loadTitleStatusSetting: async () => {
            if (setting instanceof Error) throw setting;
            return setting;
        },
    };
}

let taskSeq = 0;
async function addTask(type: string, state: string, extra: Record<string, unknown> = {}): Promise<string> {
    const taskId = `task-${++taskSeq}`;
    await database('tasks').insert({
        task_id: taskId, repository: REPOSITORY, issue_number: type === 'issue' ? 12 : PR, task_type: type,
        created_at: new Date(Date.parse('2026-11-13T08:00:00Z') + taskSeq * 60_000).toISOString(),
        initial_job_data: JSON.stringify(extra), pr_number: type === 'issue' ? PR : null,
    });
    await database('task_history').insert({ task_id: taskId, state });
    return taskId;
}

async function setTaskState(taskId: string, state: string): Promise<void> {
    await database('task_history').insert({ task_id: taskId, state });
}

async function addScore(score: number): Promise<void> {
    await database('review_scores').insert({ repository_id: REPOSITORY, pr_number: PR, score, created_at: new Date().toISOString() });
}

function setUltrafix(state: Record<string, unknown>): void {
    redis.values.set(`ultrafix:state:integry:propr:${PR}`, JSON.stringify({
        goal: 7, maxCycles: 5, cycleCount: 1, active: true, completionStatus: null, completionReason: null, finalScore: null, completedAt: null, ...state,
    }));
}

async function sync(): Promise<void> {
    await syncPullRequestStatus(REPOSITORY, PR, deps());
}

/** Syncs, then again once a ⚠️ or ✅ has had time to settle. */
async function syncSettled(): Promise<void> {
    await sync();
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS + 10));
    await sync();
}

test('a new pull request is created with 🔨 only while the status is maintained and the setting is on', async () => {
    assert.equal(await initialPullRequestTitle(REPOSITORY, TITLE), TITLE, 'a process that does not maintain the status changes no title');
    enablePullRequestStatusSync(deps());
    try {
        // The real setting cannot be read in this suite (no configuration store): the title is left as given.
        assert.equal(await initialPullRequestTitle(REPOSITORY, TITLE), TITLE);
    } finally {
        disablePullRequestStatusSync();
    }
});

test('creation costs no rename, and a full Ultrafix loop to the goal with passing checks renames once', async () => {
    const implementation = await addTask('issue', 'processing');
    await sync();
    assert.deepEqual(github.renames, [], 'the 🔨 the pull request was created with is already right');
    await setTaskState(implementation, 'completed');

    // Review, fix cycles and CI waits stay inside working.
    setUltrafix({ cycleCount: 0 });
    const review = await addTask('pr-comment', 'processing', { comments: [{ commandMode: 'review' }] });
    await sync();
    await setTaskState(review, 'completed');
    await addScore(5);
    await sync();
    const fix = await addTask('pr-comment', 'claude_execution', { commandMode: 'fix' });
    setUltrafix({ cycleCount: 1 });
    await sync();
    await setTaskState(fix, 'completed');
    setUltrafix({ cycleCount: 2, waitingForCi: true });
    await sync();
    await addScore(8);
    setUltrafix({ cycleCount: 2, active: false, completionStatus: 'succeeded', finalScore: 8, completedAt: new Date().toISOString() });
    await syncSettled();
    await syncSettled();

    assert.deepEqual(github.renames, [`✅⑧ ${TITLE}`]);
});

test('checks pending keep 🔨; a failure without follow-up shows ⚠️, passing checks show ✅', async () => {
    await addTask('issue', 'completed');
    await addScore(8);
    github.checkRuns = [{ name: 'unit', status: 'in_progress', conclusion: null }];
    await syncSettled();
    assert.equal(github.pull.title, `🔨 ${TITLE}`);

    github.checkRuns = [{ name: 'unit', status: 'completed', conclusion: 'failure' }];
    await sync();
    assert.equal(github.pull.title, `🔨 ${TITLE}`, '⚠️ is held until it settles');
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS + 10));
    await sync();
    assert.equal(github.pull.title, `⚠️⑧ ${TITLE}`);

    github.checkRuns = [{ name: 'unit', status: 'completed', conclusion: 'success' }];
    await syncSettled();
    assert.equal(github.pull.title, `✅⑧ ${TITLE}`);
    assert.deepEqual(github.renames, [`⚠️⑧ ${TITLE}`, `✅⑧ ${TITLE}`]);
});

test('a brief ⚠️ between a failed check and its queued follow-up costs no rename', async () => {
    await addTask('issue', 'completed');
    await addScore(8);
    github.checkRuns = [{ name: 'unit', status: 'completed', conclusion: 'failure' }];
    await sync();
    queuedJobs = 1;
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS + 10));
    await sync();
    queuedJobs = 0;
    await addTask('pr-comment', 'processing', { commandMode: 'fix' });
    await syncSettled();
    assert.deepEqual(github.renames, []);
    assert.equal(github.pull.title, `🔨 ${TITLE}`);
});

test('a follow-up on a ✅ pull request renames it to 🔨 at once and back only when the work finished', async () => {
    await addTask('issue', 'completed');
    await addScore(8);
    await syncSettled();
    assert.equal(github.pull.title, `✅⑧ ${TITLE}`);

    const followUp = await addTask('pr-comment', 'processing', { comments: [{ commandMode: 'default' }] });
    await sync();
    assert.equal(github.pull.title, `🔨 ${TITLE}`);
    await setTaskState(followUp, 'completed');
    github.checkRuns = [{ name: 'unit', status: 'queued', conclusion: null }];
    await syncSettled();
    assert.equal(github.pull.title, `🔨 ${TITLE}`, 'still 🔨 while the checks of the follow-up run');
    github.checkRuns = [{ name: 'unit', status: 'completed', conclusion: 'success' }];
    await syncSettled();
    assert.equal(github.pull.title, `✅⑧ ${TITLE}`);
    assert.deepEqual(github.renames, [`✅⑧ ${TITLE}`, `🔨 ${TITLE}`, `✅⑧ ${TITLE}`]);
});

test('a person\'s edit to the rest of the title survives later state changes', async () => {
    const implementation = await addTask('issue', 'processing');
    await sync();
    github.pull.title = '🔨 [12 by Claude Opus 5.5] A better title, by a person';
    await setTaskState(implementation, 'completed');
    await addScore(9);
    await syncSettled();
    assert.equal(github.pull.title, '✅⑨ [12 by Claude Opus 5.5] A better title, by a person');
});

test('a slot a person removed comes back on the next state change, not before', async () => {
    const implementation = await addTask('issue', 'processing');
    await sync();
    github.pull.title = TITLE;
    await sync();
    assert.equal(github.pull.title, TITLE, 'still working: the slot stays removed');
    await setTaskState(implementation, 'completed');
    await syncSettled();
    assert.equal(github.pull.title, `✅ ${TITLE}`);
});

test('a rename GitHub rejected is written again with the same slot, not taken for a slot a person removed', async () => {
    await addTask('issue', 'completed');
    github.pull.title = TITLE;
    await sync();
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS + 10));
    github.rejectPatches = 1;
    let recognisedDuringPatch: string | null = null;
    github.onPatch = async () => {
        // The edited webhook of the rename can arrive before the PATCH returns.
        if (typeof github.calls.at(-1)?.params.title === 'string') {
            recognisedDuringPatch = await classifyPullRequestStatusEdit(
                { ...editedWebhook({ title: { from: TITLE } }), pull_request: { ...editedWebhook({}).pull_request as object, title: `✅ ${TITLE}` } }, 'pull_request');
        }
    };
    await assert.rejects(sync(), /Validation Failed/);
    github.onPatch = null;
    assert.equal(recognisedDuringPatch, 'own', 'the pending rename is recognised as ProPR\'s own');
    assert.equal(github.pull.title, TITLE);

    // Another process sees the pending record only through Redis.
    resetPullRequestTitleStateForTests();
    await syncSettled();
    assert.equal(github.pull.title, `✅ ${TITLE}`);
    assert.deepEqual(github.renames, [`✅ ${TITLE}`]);

    // Once GitHub accepted it, a person removing the slot is respected again.
    github.pull.title = TITLE;
    await syncSettled();
    assert.equal(github.pull.title, TITLE);
});

test('a rejected 🔨 insertion is written again on the next update', async () => {
    await addTask('issue', 'processing');
    github.pull.title = TITLE;
    github.rejectPatches = 1;
    await assert.rejects(sync(), /Validation Failed/);
    assert.equal(github.pull.title, TITLE);
    await sync();
    assert.equal(github.pull.title, `🔨 ${TITLE}`);
    assert.deepEqual(github.renames, [`🔨 ${TITLE}`]);
});

test('merging or closing removes the slot; turning the setting off removes it on the next transition', async () => {
    await addTask('issue', 'completed');
    await syncSettled();
    assert.equal(github.pull.title, `✅ ${TITLE}`);
    github.pull.state = 'closed';
    github.pull.merged = true;
    await sync();
    assert.equal(github.pull.title, TITLE);
    const writes = github.writes().length;
    await sync();
    assert.equal(github.writes().length, writes, 'no PATCH when the title is already right');

    github.pull.state = 'open';
    github.pull.merged = false;
    github.pull.title = `🔨 ${TITLE}`;
    setting = false;
    await sync();
    assert.equal(github.pull.title, TITLE);
    setting = new Error('configuration unavailable');
    github.pull.title = `🔨 ${TITLE}`;
    await syncSettled();
    assert.equal(github.pull.title, `🔨 ${TITLE}`, 'an unreadable setting leaves the title unchanged');
});

test('pull requests ProPR did not create keep their title', async () => {
    github.pull.title = `✅ ${TITLE}`;
    await syncSettled();
    github.pull.state = 'closed';
    await sync();
    assert.equal(github.pull.title, `✅ ${TITLE}`);
    assert.deepEqual(github.writes(), []);
});

test('the slot is left out when it would exceed GitHub\'s 256 character title limit', async () => {
    await addTask('issue', 'completed');
    github.pull.title = 'a'.repeat(255);
    await syncSettled();
    assert.equal(github.pull.title, 'a'.repeat(255));
});

/** The `edited` webhook GitHub sends after a change to the title (and optionally the body). */
function editedWebhook(changes: Record<string, { from: string }>): Record<string, unknown> {
    return {
        action: 'edited', changes, repository: { full_name: REPOSITORY },
        pull_request: { number: PR, body: github.pull.body, title: github.pull.title, head: { ref: '12-feature' }, base: { ref: 'main' } },
        sender: { login: 'propr[bot]' },
    };
}

test('the edited webhook of a ProPR rename causes no further write or work', async () => {
    await addTask('issue', 'completed');
    const before = { title: github.pull.title, body: github.pull.body };
    await syncSettled();
    assert.equal(github.pull.title, `✅ ${TITLE}`);
    const signalled: Array<[string, number]> = [];
    enablePullRequestStatusSync(deps());
    setPullRequestStatusSyncRunner((repository, prNumber) => { signalled.push([repository, prNumber]); });
    try {
        const writes = github.writes().length;
        const event = editedWebhook({ title: { from: before.title }, body: { from: before.body } });
        assert.equal(await classifyPullRequestStatusEdit(event, 'pull_request'), 'own');
        assert.deepEqual(await processWebhookEvent(event, 'pull_request', 'corr-1'), { status: 'ignored', reason: 'pull_request_status_edit' });
        // Another process knows the rename only through Redis.
        resetPullRequestTitleStateForTests();
        resetPullRequestStatusProvenanceForTests();
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook({ title: { from: before.title } }), 'pull_request'), 'own');
        assert.deepEqual(signalled, []);
        assert.equal(github.writes().length, writes);

        // A person removing the slot is reconciled without other work; a person's title edit is ordinary work.
        github.pull.title = TITLE;
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook({ title: { from: `✅ ${TITLE}` } }), 'pull_request'), 'foreign');
        github.pull.title = `✅ ${TITLE} (renamed)`;
        assert.equal(await classifyPullRequestStatusEdit(editedWebhook({ title: { from: `✅ ${TITLE}` } }), 'pull_request'), null);
    } finally {
        disablePullRequestStatusSync();
    }
});

test('[Epic] detection accepts titles with and without the slot', () => {
    for (const slot of ['', '🔨 ', '⚠️⑥ ', '⚠ ', '✅⑧ ']) assert.equal(isEpicPullRequestTitle(`${slot}[Epic] Plan`), true, slot);
    assert.equal(isEpicPullRequestTitle('Not an [Epic]'), false);
    assert.equal(isEpicPullRequestTitle(null), false);
});
