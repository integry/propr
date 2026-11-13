import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import knexFactory, { type Knex } from 'knex';
import type { PullRequestStatusSyncDeps } from '../src/services/pullRequestStatus/pullRequestStatusSync.js';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../src/db/connection.js');
const { extractPullRequestStatusBlock } = await import('../src/services/pullRequestStatus/pullRequestStatusBlock.js');
const { syncPullRequestStatus } = await import('../src/services/pullRequestStatus/pullRequestStatusSync.js');
const { resetPullRequestTitleStateForTests, setPullRequestTitleSettleMsForTests } = await import('../src/services/pullRequestStatus/pullRequestStatusTitle.js');
const { setPullRequestStatusEpicSyncRunner } = await import('../src/services/pullRequestStatus/pullRequestStatusSignal.js');
const { createEpicSyncRunner } = await import('../src/services/pullRequestStatus/pullRequestStatusEpicSync.js');
const { signalPullRequestStatusFromWebhook } = await import('../src/webhook/pullRequestStatusWebhook.js');
const { EPIC_PROGRESS_MARKER, buildEpicProgressComment } = await import('../src/webhook/epicMergeProgress.js');
const { isEpicPullRequestTitle } = await import('../src/webhook/planIssueTracking.js');

const REPOSITORY = 'integry/propr';
const EPIC_BRANCH = '800-epic-short-name-x7y';
const EPIC = 900;
const EPIC_BODY = [
    '## Scheduler primitives', '', 'This Epic PR aggregates all changes for the plan: **Scheduler primitives**', '',
    '### Issues in this Epic', '- #800: First issue', '- #801: Second issue', '- #802: Third issue', '',
    '### Auto-close', 'When this PR is merged, the following issues will be automatically closed:', '',
    'Fixes #800', 'Fixes #801', 'Fixes #802', '', '---', '*Created automatically by ProPR*',
].join('\n');

interface FakePull {
    number: number; state: string; merged: boolean; merged_at: string | null; mergeable: boolean | null; body: string; title: string;
    head: { sha: string; ref: string; repo: { full_name: string } }; base: { ref: string; sha: string };
}

function pull(number: number, overrides: Partial<FakePull>): FakePull {
    return {
        number, state: 'open', merged: false, merged_at: null, mergeable: true, body: '', title: `PR ${number}`,
        head: { sha: `head-${number}`, ref: `${number}-branch`, repo: { full_name: REPOSITORY } }, base: { ref: 'main', sha: 'base-1' },
        ...overrides,
    };
}

class FakeGitHub {
    pulls = new Map<number, FakePull>();
    comments: Array<{ id: number; body: string; user: { login: string } }> = [];
    writes: Array<{ route: string; params: Record<string, unknown> }> = [];
    async request(route: string, params: Record<string, unknown>) {
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: structuredClone(this.pulls.get(Number(params.pull_number))) };
        if (route === 'GET /repos/{owner}/{repo}/pulls') {
            const listed = [...this.pulls.values()].filter(candidate =>
                (!params.base || candidate.base.ref === params.base)
                && (!params.head || `integry:${candidate.head.ref}` === params.head)
                && (params.state === 'all' || (params.state ?? 'open') === candidate.state));
            return { data: Number(params.page ?? 1) > 1 ? [] : structuredClone(listed) };
        }
        if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') {
            this.writes.push({ route, params });
            const target = this.pulls.get(Number(params.pull_number))!;
            if (typeof params.body === 'string') target.body = params.body;
            if (typeof params.title === 'string') target.title = params.title;
            return { data: structuredClone(target) };
        }
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') {
            return { data: { total_count: 1, check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success' }] } };
        }
        if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/status') return { data: { state: 'success', total_count: 0, statuses: [] } };
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
            return { data: Number(params.page ?? 1) > 1 ? [] : structuredClone(this.comments) };
        }
        if (route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
            this.writes.push({ route, params });
            this.comments.find(comment => comment.id === params.comment_id)!.body = String(params.body);
            return { data: {} };
        }
        throw new Error(`unexpected route ${route}`);
    }
    epic() { return this.pulls.get(EPIC)!; }
    progressComment() { return this.comments.find(comment => comment.body.includes(EPIC_PROGRESS_MARKER))?.body ?? ''; }
}

let database: Knex;
let github: FakeGitHub;
let titleSetting = true;

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
    setPullRequestTitleSettleMsForTests(null);
    setPullRequestStatusEpicSyncRunner(null);
    await database.destroy();
    await closeConnection();
});

beforeEach(async () => {
    for (const name of ['tasks', 'task_history', 'plan_issues', 'task_drafts', 'epic_execution_queues', 'goals', 'review_scores']) await database(name).del();
    resetPullRequestTitleStateForTests();
    setPullRequestTitleSettleMsForTests(0);
    titleSetting = true;
    github = new FakeGitHub();
    github.pulls.set(EPIC, pull(EPIC, { title: '[Epic] Scheduler primitives', body: EPIC_BODY, head: { sha: 'epic-head', ref: EPIC_BRANCH, repo: { full_name: REPOSITORY } } }));
    // Sub-PR #910 (issue #800) merged; #911 (issue #801) is open, ProPR's, checks passing: ready and waiting to be merged.
    github.pulls.set(910, pull(910, { state: 'closed', merged: true, merged_at: '2026-11-13T08:00:00Z', base: { ref: EPIC_BRANCH, sha: 'e1' } }));
    github.pulls.set(911, pull(911, { title: '✅ [801 by Claude Opus 5.5] Second issue', head: { sha: 'h911', ref: '801/claude-second', repo: { full_name: REPOSITORY } }, base: { ref: EPIC_BRANCH, sha: 'e1' } }));
    github.comments.push({ id: 1, body: `### Epic progress: Scheduler primitives\n\nold\n${EPIC_PROGRESS_MARKER}`, user: { login: 'propr-dev[bot]' } });

    await database('task_drafts').insert({ draft_id: 'draft-1', repository: REPOSITORY, name: 'Scheduler primitives', context_config: JSON.stringify({ epicLabel: `base-${EPIC_BRANCH}` }) });
    await database('plan_issues').insert([
        { repository: REPOSITORY, issue_number: 800, draft_id: 'draft-1', status: 'merged', pr_number: 910, created_at: '1' },
        { repository: REPOSITORY, issue_number: 801, draft_id: 'draft-1', status: 'under_review', pr_number: 911, created_at: '2' },
        { repository: REPOSITORY, issue_number: 802, draft_id: 'draft-1', status: 'pending', pr_number: null, created_at: '3' },
    ]);
    await database('epic_execution_queues').insert({ draft_id: 'draft-1', issues: JSON.stringify([800, 801, 802]), cursor: 1, status: 'active', ready: true, parallel: false });
    await database('tasks').insert({ task_id: 't-911', repository: REPOSITORY, issue_number: 801, task_type: 'issue', created_at: '2026-11-13T08:30:00Z', initial_job_data: '{}', pr_number: 911 });
    await database('task_history').insert({ task_id: 't-911', state: 'completed' });
});

function deps(): Partial<PullRequestStatusSyncDeps> {
    return {
        github, redis: null, now: () => new Date('2026-11-13T09:41:00Z'),
        sources: { db: database, redis: null, loadRatingGoal: async () => 7, loadNonBlockingChecks: async () => [], countQueuedJobs: async () => 0 },
        loadTitleStatusSetting: async () => titleSetting,
    };
}

function statusLine(number = EPIC): string {
    return extractPullRequestStatusBlock(github.pulls.get(number)!.body)?.split('\n')[1] ?? '';
}

async function mergeSubPr911(): Promise<void> {
    Object.assign(github.pulls.get(911)!, { state: 'closed', merged: true, merged_at: '2026-11-13T09:00:00Z' });
    await database('plan_issues').where({ issue_number: 801 }).update({ status: 'merged' });
    await database('epic_execution_queues').update({ cursor: 2 });
}

test('a ready sub-PR waiting to be merged shows ⚠️ with the count, and the block names it', async () => {
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(statusLine(), '**ProPR** ⚠️ 1 of 3 issues merged · #911 (issue #801) waits to be merged into the epic branch · updated 09:41 UTC');
    assert.equal(github.epic().title, '[Epic] Scheduler primitives', '⚠️ waits to settle before the title shows it');
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.epic().title, '⚠️ 1/3 [Epic] Scheduler primitives');
    assert.ok(github.epic().body.includes(EPIC_BODY), 'the issue list and the Fixes lines are kept');
    assert.ok(isEpicPullRequestTitle(github.epic().title), '[Epic] is still detected behind the slot and count');
});

test('the progress comment lists the open sub-PR and the next issue; an unchanged comment is not written', async () => {
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    const comment = github.progressComment();
    assert.equal(comment, buildEpicProgressComment(
        { merged: 1, total: 3, excluded: 0, mergedPullRequests: [910] }, 'Scheduler primitives', undefined,
        ['In progress: #911 (issue #801, Second issue) - ready to merge', 'Up next: #802 (Third issue)'],
    ));
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    const writes = github.writes.length;
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.writes.length, writes, 'nothing changed: no GitHub write');
});

test('a merge into the epic branch renames the title once, and the next queued issue keeps it working', async () => {
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    await mergeSubPr911();
    const renamesBefore = github.writes.filter(write => typeof write.params.title === 'string').length;
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.epic().title, '🔨 2/3 [Epic] Scheduler primitives');
    assert.equal(github.writes.filter(write => typeof write.params.title === 'string').length, renamesBefore + 1, 'one rename per merge');
    assert.match(statusLine(), /^\*\*ProPR\*\* 🔨 2 of 3 issues merged · #802 starts next · /);
    assert.match(github.progressComment(), /Merged child PRs: #910, #911\n\nUp next: #802 \(Third issue\)\n/);
    assert.doesNotMatch(github.progressComment(), /In progress/);
});

test('every issue merged with passing checks shows ✅ N/N', async () => {
    await mergeSubPr911();
    github.pulls.set(912, pull(912, { state: 'closed', merged: true, merged_at: '2026-11-13T09:20:00Z', base: { ref: EPIC_BRANCH, sha: 'e1' } }));
    await database('plan_issues').where({ issue_number: 802 }).update({ status: 'merged', pr_number: 912 });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.epic().title, '✅ 3/3 [Epic] Scheduler primitives');
    assert.equal(statusLine(), '**ProPR** ✅ 3 of 3 issues merged · checks: 1 passed · updated 09:41 UTC');
});

test('with prTitleStatus off the title is left alone; the block and the comment are still written', async () => {
    titleSetting = false;
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.epic().title, '[Epic] Scheduler primitives');
    assert.match(statusLine(), /⚠️ 1 of 3 issues merged/);
    assert.match(github.progressComment(), /In progress: #911/);
});

test('a sub-PR whose status changed signals its epic; an unchanged one does not', async () => {
    const signalled: string[] = [];
    setPullRequestStatusEpicSyncRunner({ forBranch: (_repository, branch) => signalled.push(branch), forPlan: () => {} });
    await syncPullRequestStatus(REPOSITORY, 911, deps());
    assert.deepEqual(signalled, [EPIC_BRANCH]);
    await syncPullRequestStatus(REPOSITORY, 911, deps());
    assert.deepEqual(signalled, [EPIC_BRANCH], 'nothing changed on the sub-PR');
    setPullRequestStatusEpicSyncRunner(null);
});

test('a pull request opened into an epic branch signals the epic', () => {
    const signalled: string[] = [];
    setPullRequestStatusEpicSyncRunner({ forBranch: (_repository, branch) => signalled.push(branch), forPlan: () => {} });
    signalPullRequestStatusFromWebhook({ action: 'opened', repository: { full_name: REPOSITORY }, pull_request: { number: 913, base: { ref: EPIC_BRANCH } } }, 'pull_request');
    signalPullRequestStatusFromWebhook({ action: 'opened', repository: { full_name: REPOSITORY }, pull_request: { number: 914, base: { ref: 'main' } } }, 'pull_request');
    assert.deepEqual(signalled, [EPIC_BRANCH], 'only a pull request into an epic branch');
    setPullRequestStatusEpicSyncRunner(null);
});

test('an epic signal, by branch or by plan, schedules the update of the open epic pull request', async () => {
    const scheduled: number[] = [];
    const runner = createEpicSyncRunner({ github: async () => github, db: database, schedule: (_repository, number) => scheduled.push(number), enabled: () => true });
    runner.forPlan('draft-1');
    runner.forBranch(REPOSITORY, EPIC_BRANCH);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    runner.stop();
    assert.deepEqual(scheduled, [EPIC], 'a burst of signals costs one lookup');
});
