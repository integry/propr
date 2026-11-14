import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import knexFactory, { type Knex } from 'knex';
import type { PullRequestStatusSyncDeps } from '../src/services/pullRequestStatus/pullRequestStatusSync.js';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('../src/db/connection.js');
const { extractPullRequestStatusBlock } = await import('../src/services/pullRequestStatus/pullRequestStatusBlock.js');
const { disablePullRequestStatusSync, enablePullRequestStatusSync, syncPullRequestStatus } = await import('../src/services/pullRequestStatus/pullRequestStatusSync.js');
const { requestPullRequestStatusSync } = await import('../src/services/pullRequestStatus/pullRequestStatusSignal.js');
const { resetEpicChildReadsForTests } = await import('../src/services/pullRequestStatus/pullRequestStatusEpicChildReads.js');
const { resetPullRequestTitleStateForTests, setPullRequestTitleSettleMsForTests } = await import('../src/services/pullRequestStatus/pullRequestStatusTitle.js');
const { setPullRequestStatusEpicSyncRunner } = await import('../src/services/pullRequestStatus/pullRequestStatusSignal.js');
const { createEpicSyncRunner, setEpicChildReadContinueMsForTests, setEpicProgressLeaseWaitMsForTests } = await import('../src/services/pullRequestStatus/pullRequestStatusEpicSync.js');
const { signalPullRequestStatusFromWebhook } = await import('../src/webhook/pullRequestStatusWebhook.js');
const { EPIC_PROGRESS_MARKER, buildEpicProgressComment, extractEpicProgressActivityLines } = await import('../src/webhook/epicMergeProgress.js');
const { isEpicPullRequestTitle } = await import('../src/webhook/planIssueTracking.js');
const { syncEpicProgressCommentForStatus } = await import('../src/services/pullRequestStatus/pullRequestStatusEpicSync.js');
const { EPIC_PROGRESS_SCRIPTS, runEpicProgressUpdate, withEpicProgressLeaseIfFree } = await import('../src/webhook/epicMergeProgressRetry.js');
const {
    EPIC_ACTIVITY_ADVANCE_SCRIPT, EPIC_ACTIVITY_CLAIM_SCRIPT, EPIC_ACTIVITY_SUPERSEDED_SCRIPT, advanceEpicActivityFence, claimEpicActivitySnapshot,
    orderEpicActivityRead, UNORDERED_EPIC_ACTIVITY_SNAPSHOT,
} = await import('../src/services/pullRequestStatus/pullRequestStatusEpicActivityFence.js');
const { syncEpicSideOfStatus } = await import('../src/services/pullRequestStatus/pullRequestStatusEpicSync.js');
const { PullRequestBodyLockLostError } = await import('../src/services/pullRequestStatus/pullRequestBodyLock.js');
const { agentBlockedHeadReason } = await import('../src/services/taskPlanning/epicQueueBlockedHead.js');
const { EPIC_FINAL_MERGE_MARKER } = await import('../src/webhook/epicMergeProgress.js');
const { PR_BODY_MAX_LENGTH } = await import('@propr/shared');

const REPOSITORY = 'integry/propr';
const EPIC_BRANCH = '800-epic-short-name-x7y';
const EPIC = 900;
const EPIC_BODY = [
    '## Scheduler primitives', '', 'This Epic PR aggregates all changes for the plan: **Scheduler primitives**', '',
    '### Issues in this Epic', '- #800: First issue', '- #801: Second issue', '- #802: Third issue', '',
    '### Auto-close', 'When this PR is merged, the following issues will be automatically closed:', '',
    'Fixes #800', 'Fixes #801', 'Fixes #802', '', '---', '*Created automatically by ProPR*',
].join('\n');

const PROGRESS_AFTER_910 = { merged: 1, total: 3, excluded: 0, mergedPullRequests: [910] };
const PROGRESS_AFTER_911 = { merged: 2, total: 3, excluded: 0, mergedPullRequests: [910, 911] };

interface FakePull {
    number: number; state: string; merged: boolean; merged_at: string | null; mergeable: boolean | null; body: string; title: string;
    head: { sha: string; ref: string; repo: { full_name: string } }; base: { ref: string; sha: string }; updated_at?: string;
}

function pull(number: number, overrides: Partial<FakePull>): FakePull {
    return {
        number, state: 'open', merged: false, merged_at: null, mergeable: true, body: '', title: `PR ${number}`,
        head: { sha: `head-${number}`, ref: `${number}-branch`, repo: { full_name: REPOSITORY } }, base: { ref: 'main', sha: 'base-1' },
        ...overrides,
    };
}

/** The page GitHub returns of a list (per_page at most 100). */
function onePage<T>(items: T[], params: Record<string, unknown>): T[] {
    const perPage = Math.min(Number(params.per_page ?? 30), 100);
    const page = Number(params.page ?? 1);
    return items.slice((page - 1) * perPage, page * perPage);
}

class FakeGitHub {
    pulls = new Map<number, FakePull>();
    comments: Array<{ id: number; body: string; user: { login: string } }> = [];
    writes: Array<{ route: string; params: Record<string, unknown> }> = [];
    /** Pull requests read one by one, in order. */
    reads: number[] = [];
    /** Runs after each write, as a concurrent writer would act between this pass's requests. */
    afterWrite: ((route: string) => void) | null = null;
    async request(route: string, params: Record<string, unknown>) {
        const result = await this.handle(route, params);
        if (!route.startsWith('GET ')) this.afterWrite?.(route);
        return result;
    }
    private async handle(route: string, params: Record<string, unknown>) {
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
            this.reads.push(Number(params.pull_number));
            return { data: structuredClone(this.pulls.get(Number(params.pull_number))) };
        }
        if (route === 'GET /repos/{owner}/{repo}/pulls') {
            const listed = [...this.pulls.values()].filter(candidate =>
                (!params.base || candidate.base.ref === params.base)
                && (!params.head || `integry:${candidate.head.ref}` === params.head)
                && (params.state === 'all' || (params.state ?? 'open') === candidate.state));
            return { data: structuredClone(onePage(listed, params)) };
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
            return { data: structuredClone(onePage(this.comments, params)) };
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
    resetEpicChildReadsForTests();
    setPullRequestTitleSettleMsForTests(0);
    titleSetting = true;
    github = new FakeGitHub();
    github.pulls.set(EPIC, pull(EPIC, { title: '[Epic] Scheduler primitives', body: EPIC_BODY, head: { sha: 'epic-head', ref: EPIC_BRANCH, repo: { full_name: REPOSITORY } } }));
    // Sub-PR #910 (issue #800) merged; #911 (issue #801) is open, ProPR's, checks passing: ready and waiting to be merged.
    github.pulls.set(910, pull(910, { state: 'closed', merged: true, merged_at: '2026-11-13T08:00:00Z', base: { ref: EPIC_BRANCH, sha: 'e1' } }));
    github.pulls.set(911, pull(911, { title: '✅ [801 by Claude Opus 5.5] Second issue', head: { sha: 'h911', ref: '801/claude-second', repo: { full_name: REPOSITORY } }, base: { ref: EPIC_BRANCH, sha: 'e1' } }));
    // As the merge progress update wrote it when #910 merged, before the status sync added activity lines.
    github.comments.push({ id: 1, body: buildEpicProgressComment(PROGRESS_AFTER_910, 'Scheduler primitives'), user: { login: 'propr-dev[bot]' } });

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

/** #911 merges; the merge progress update rewrites the counts, keeping the activity lines it found. */
async function mergeSubPr911(): Promise<void> {
    Object.assign(github.pulls.get(911)!, { state: 'closed', merged: true, merged_at: '2026-11-13T09:00:00Z' });
    await database('plan_issues').where({ issue_number: 801 }).update({ status: 'merged' });
    await database('epic_execution_queues').update({ cursor: 2 });
    const comment = github.comments.find(candidate => candidate.body.includes(EPIC_PROGRESS_MARKER))!;
    comment.body = buildEpicProgressComment(PROGRESS_AFTER_911, 'Scheduler primitives', undefined, extractEpicProgressActivityLines(comment.body));
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
        PROGRESS_AFTER_910, 'Scheduler primitives', undefined,
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

/** A description a person filled so close to GitHub's limit that not even the compact status block fits. */
const FULL_BODY = 'x'.repeat(PR_BODY_MAX_LENGTH - 20);

function subPrPatches(number: number): number {
    return github.writes.filter(write => write.route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}' && write.params.pull_number === number).length;
}

test('a sub-PR whose status changes without anything to write (title setting off, body full) still updates its epic', async () => {
    titleSetting = false;
    Object.assign(github.pulls.get(911)!, { title: '[801 by Claude Opus 5.5] Second issue', body: FULL_BODY });
    // #911's Ultrafix loop runs: the sub-PR is working, and the epic shows it in progress.
    const ultrafix = new Map<string, string>([['ultrafix:state:integry:propr:911', JSON.stringify({ active: true, cycleCount: 3, maxCycles: 10, goal: 8 })]]);
    const withLoop = (): Partial<PullRequestStatusSyncDeps> => {
        const base = deps();
        return { ...base, sources: { ...base.sources!, redis: { get: async (key: string) => ultrafix.get(key) ?? null } } };
    };
    await syncPullRequestStatus(REPOSITORY, 911, withLoop());
    await syncPullRequestStatus(REPOSITORY, EPIC, withLoop());
    assert.match(statusLine(), /^\*\*ProPR\*\* 🔨 1 of 3 issues merged · #801 in progress \(Ultrafix cycle 4 of 10\)/);
    assert.equal(github.pulls.get(911)!.body, FULL_BODY, 'no room for the block');

    // The loop finishes with its checks passing: #911 is ready, its plan issue stays under_review.
    ultrafix.set('ultrafix:state:integry:propr:911', JSON.stringify({
        active: false, cycleCount: 4, maxCycles: 10, goal: 8, completionStatus: 'succeeded', finalScore: 9, completedAt: '2026-11-13T09:40:00Z',
    }));
    enablePullRequestStatusSync(withLoop());
    try {
        // The sub-PR's own transition only: the epic is updated through the signal its sync sends.
        requestPullRequestStatusSync(REPOSITORY, 911);
        const deadline = Date.now() + 8_000;
        while (!/⚠️ 1 of 3 issues merged/.test(statusLine()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 1 of 3 issues merged · #911 \(issue #801\) waits to be merged into the epic branch/);
    } finally {
        disablePullRequestStatusSync();
    }
    assert.equal(subPrPatches(911), 0, 'nothing was written on the sub-PR');
});

test('a sub-PR whose status is unchanged and unwritable sends no further signal', async () => {
    titleSetting = false;
    Object.assign(github.pulls.get(911)!, { title: '[801 by Claude Opus 5.5] Second issue', body: FULL_BODY });
    const signalled: string[] = [];
    setPullRequestStatusEpicSyncRunner({ forBranch: (_repository, branch) => signalled.push(branch), forPlan: () => {} });
    try {
        await syncPullRequestStatus(REPOSITORY, 911, deps());
        assert.deepEqual(signalled, [EPIC_BRANCH], 'the status computed first is new to the epic');
        await syncPullRequestStatus(REPOSITORY, 911, deps());
        assert.deepEqual(signalled, [EPIC_BRANCH], 'the same status again: no signal');
        await database('task_history').insert({ task_id: 't-911', state: 'processing' });
        await syncPullRequestStatus(REPOSITORY, 911, deps());
        assert.deepEqual(signalled, [EPIC_BRANCH, EPIC_BRANCH], 'a new status signals, with nothing written');
        assert.equal(subPrPatches(911), 0);
    } finally {
        setPullRequestStatusEpicSyncRunner(null);
    }
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

// --- the status pass and the merge progress update share the epic ---

/** The Redis of the epic progress lease: keys, the retry hash, and its scripts matched by identity. */
class FakeLeaseRedis {
    keys = new Map<string, string>();
    retries = new Map<string, string>();
    locked: string[] = [];
    async set(key: string, value: string) {
        this.locked.push(key);
        if (this.keys.has(key)) return null;
        this.keys.set(key, value);
        return 'OK' as const;
    }
    async eval(script: string, count: number, key: string, ...args: string[]) {
        if (script === EPIC_PROGRESS_SCRIPTS.compareAndExtendKey) return this.keys.get(key) === args[0] ? 1 : 0;
        if (script === EPIC_PROGRESS_SCRIPTS.compareAndDeleteKey) return this.keys.get(key) === args[0] && this.keys.delete(key) ? 1 : 0;
        if (script === EPIC_PROGRESS_SCRIPTS.compareAndDeleteField) return this.retries.get(args[0]) === args[1] && this.retries.delete(args[0]) ? 1 : 0;
        // The activity fence (pullRequestStatusEpicActivityFence): the sequence counter and the fence, as the Lua scripts keep them.
        if (script === EPIC_ACTIVITY_CLAIM_SCRIPT) {
            const [fenceKey] = args;
            const sequence = Number(this.keys.get(key) ?? '0') + 1;
            this.keys.set(key, String(sequence));
            if (sequence === 1) this.keys.delete(fenceKey);
            return sequence;
        }
        if (script === EPIC_ACTIVITY_SUPERSEDED_SCRIPT) return Number(this.keys.get(key) ?? '0') > Number(args[0]) ? 1 : 0;
        if (script === EPIC_ACTIVITY_ADVANCE_SCRIPT) {
            if (Number(this.keys.get(key) ?? '0') >= Number(args[0])) return 0;
            this.keys.set(key, args[0]);
            return 1;
        }
        throw new Error(`unexpected script (${count} keys)`);
    }
    /** The lease and fence state, without the activity sequence and fence keys. */
    leaseKeys() { return [...this.keys.keys()].filter(name => !name.includes(':epic-activity-')); }
    async hget(_key: string, field: string) { return this.retries.get(field) ?? null; }
    async hset(_key: string, field: string, value: string) { this.retries.set(field, value); return 1; }
    async hgetall() { return Object.fromEntries(this.retries); }
}

const LOCK_KEY = `epic:merge-progress-lock:${REPOSITORY}#${EPIC_BRANCH}`;
const OPEN_EPIC_FACTS = {
    merged: 1, total: 3, progress: PROGRESS_AFTER_910, planName: 'Scheduler primitives', epicBranch: EPIC_BRANCH,
    children: [], startedIssues: [{ issueNumber: 801, title: 'Second issue', working: true }], upNext: [{ issueNumber: 802, title: 'Third issue' }],
};
const FINALIZED = buildEpicProgressComment(PROGRESS_AFTER_910, 'Scheduler primitives', 'main');

function mergeEpicAndFinalizeComment(): void {
    Object.assign(github.epic(), { state: 'closed', merged: true, merged_at: '2026-11-13T09:40:00Z' });
    github.comments[0].body = FINALIZED;
}

test('an epic that merges while the status pass reads its facts keeps its finalized progress comment', async () => {
    github.afterWrite = route => { if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') mergeEpicAndFinalizeComment(); };
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.progressComment(), FINALIZED, 'the merged epic is read again before the comment is written');
    assert.equal(github.writes.filter(write => write.route.includes('/issues/comments/')).length, 0);
});

test('a final-merge confirmation keeps the status pass off the comment even while GitHub still lists the epic open', async () => {
    const before = github.progressComment();
    github.comments.push({ id: 2, body: `### ✅ Epic merged\n${EPIC_FINAL_MERGE_MARKER}`, user: { login: 'propr-dev[bot]' } });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.progressComment(), before);
    github.comments.pop();
    github.comments[0].body = FINALIZED;
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.progressComment(), FINALIZED, 'a progress comment that already reports the merge is left alone');
});

test('counts the merge progress update writes while the status pass reads are kept; only the activity lines change', async () => {
    // The merge writer counted #911 (the triggering child) before GitHub's list shows it merged.
    github.afterWrite = route => {
        if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') github.comments[0].body = buildEpicProgressComment(PROGRESS_AFTER_911, 'Scheduler primitives');
    };
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.progressComment(), buildEpicProgressComment(
        PROGRESS_AFTER_911, 'Scheduler primitives', undefined,
        ['In progress: #911 (issue #801, Second issue) - ready to merge', 'Up next: #802 (Third issue)'],
    ));
});

test('the status pass waits for the merge progress lease and reads the epic again under it', async () => {
    const redis = new FakeLeaseRedis();
    redis.keys.set(LOCK_KEY, 'merge-writer');
    // The merge progress update finalizes the comment, then releases the lease.
    setTimeout(() => { mergeEpicAndFinalizeComment(); redis.keys.delete(LOCK_KEY); }, 300);
    await syncEpicProgressCommentForStatus(github as never, redis, { repository: REPOSITORY, prNumber: EPIC }, OPEN_EPIC_FACTS);
    assert.ok(redis.locked.every(key => key === LOCK_KEY) && redis.locked.length > 1, 'the same lease as the merge progress update, polled until free');
    assert.equal(github.progressComment(), FINALIZED);
    assert.equal(redis.leaseKeys().length, 0);
});

test('under a free lease the status pass writes the activity lines and releases the lease', async () => {
    const redis = new FakeLeaseRedis();
    await syncEpicProgressCommentForStatus(github as never, redis, { repository: REPOSITORY, prNumber: EPIC }, OPEN_EPIC_FACTS);
    assert.match(github.progressComment(), /\n\nIn progress: #801 \(Second issue\)\n\nUp next: #802 \(Third issue\)\n/);
    assert.deepEqual(redis.locked, [LOCK_KEY]);
    assert.equal(redis.leaseKeys().length, 0);
});

test('a merge progress update arriving while the status pass holds the lease defers to its retry', async () => {
    const redis = new FakeLeaseRedis();
    let ran = false;
    const target = { owner: 'integry', repo: 'propr', epicBranch: EPIC_BRANCH, epicPrNumber: EPIC, mergedChildPrNumber: 911 };
    const held = await withEpicProgressLeaseIfFree(target, redis, async () =>
        await runEpicProgressUpdate(target, { redis, update: async () => { ran = true; return true; } }));
    assert.deepEqual(held, { acquired: true, value: 'retry_scheduled' });
    assert.equal(ran, false, 'the merge progress update never writes alongside the status pass');
    assert.equal(redis.retries.size, 1, 'its obligation is kept for the retry sweep');
});

// --- a status pass that waited for the lease must not overwrite newer activity ---

const READY_EPIC_FACTS = {
    ...OPEN_EPIC_FACTS, startedIssues: [],
    children: [{
        prNumber: 911, issueNumber: 801, title: 'Second issue',
        status: {
            state: 'ready',
            detail: { activity: null, ultrafix: null, ultrafixStopped: null, reviewScore: null, ratingGoal: 7, checks: null, reason: null, failedChecks: [], epic: null },
        },
    }],
};
const WORKING_LINES = /\n\nIn progress: #801 \(Second issue\)\n\nUp next: #802 \(Third issue\)\n/;
const READY_LINES = /\n\nIn progress: #911 \(issue #801, Second issue\) - ready to merge\n\nUp next: #802 \(Third issue\)\n/;

test('a status pass that waited for the lease does not write its older activity over a later pass\'s newer one', async () => {
    const redis = new FakeLeaseRedis();
    const target = { repository: REPOSITORY, prNumber: EPIC };
    // Pass A read the child working, pass B read it ready afterwards: both claimed their place under the body lock, in that order.
    const olderRead = await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC);
    const newerRead = await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC);
    assert.deepEqual([olderRead, newerRead], [{ sequence: 1 }, { sequence: 2 }]);
    // The merge progress update holds the lease while A arrives: A polls for it.
    redis.keys.set(LOCK_KEY, 'merge-writer');
    const passA = syncEpicProgressCommentForStatus(github as never, redis, { ...target, snapshot: olderRead }, OPEN_EPIC_FACTS);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(redis.locked.length >= 1 && redis.keys.get(LOCK_KEY) === 'merge-writer', 'A found the lease held');
    // The merge writer releases it and B, which read the child ready, takes it first and publishes.
    redis.keys.delete(LOCK_KEY);
    await syncEpicProgressCommentForStatus(github as never, redis, { ...target, snapshot: newerRead }, READY_EPIC_FACTS as never);
    assert.match(github.progressComment(), READY_LINES, 'B wrote the newer activity');
    const writesAfterB = github.writes.length;
    await passA;
    assert.match(github.progressComment(), READY_LINES, 'A, whose read is older, left B\'s activity in place');
    assert.equal(github.writes.length, writesAfterB, 'A wrote nothing');
    assert.equal(redis.leaseKeys().length, 0, 'A released the lease it finally acquired');
});

test('a status pass whose read is the newest writes its activity after an older pass published', async () => {
    const redis = new FakeLeaseRedis();
    const target = { repository: REPOSITORY, prNumber: EPIC };
    const olderRead = await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC);
    const newerRead = await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC);
    await syncEpicProgressCommentForStatus(github as never, redis, { ...target, snapshot: olderRead }, OPEN_EPIC_FACTS);
    assert.match(github.progressComment(), WORKING_LINES);
    await syncEpicProgressCommentForStatus(github as never, redis, { ...target, snapshot: newerRead }, READY_EPIC_FACTS as never);
    assert.match(github.progressComment(), READY_LINES, 'the newer read is written over the older one, in either order of arrival');
    // An unchanged write of the newest read still fences older ones, and a sequence that starts again drops the fence with it.
    await syncEpicProgressCommentForStatus(github as never, redis, { ...target, snapshot: olderRead }, OPEN_EPIC_FACTS);
    assert.match(github.progressComment(), READY_LINES);
    redis.keys.delete(`propr:pr-status:epic-activity-seq:${REPOSITORY}#${EPIC}`);
    assert.deepEqual(await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC), { sequence: 1 });
    assert.equal(redis.keys.has(`propr:pr-status:epic-activity-fence:${REPOSITORY}#${EPIC}`), false, 'an expired sequence takes the fence with it');
});

/** Runs `run` with the epic signal runner recording the branches it is asked to refresh. */
async function recordingEpicSignals(run: () => Promise<void>): Promise<string[]> {
    const signalled: string[] = [];
    setPullRequestStatusEpicSyncRunner({ forBranch: (_repository, branch) => { signalled.push(branch); }, forPlan: () => undefined });
    try {
        await run();
    } finally {
        setPullRequestStatusEpicSyncRunner(null);
    }
    return signalled;
}

test('a newer status pass that gives up on a lease an older status pass holds asks for a fresh epic update, which publishes its activity', async () => {
    const redis = new FakeLeaseRedis();
    const target = { repository: REPOSITORY, prNumber: EPIC };
    // Pass A read the child working, pass B read it ready afterwards; A took the lease first and is still on its GitHub reads.
    const olderRead = await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC);
    const newerRead = await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC);
    redis.keys.set(LOCK_KEY, 'status-writer-A');
    const before = github.progressComment();
    setEpicProgressLeaseWaitMsForTests(400);
    let signalled: string[];
    try {
        signalled = await recordingEpicSignals(async () =>
            await syncEpicProgressCommentForStatus(github as never, redis, { ...target, snapshot: newerRead }, READY_EPIC_FACTS as never));
    } finally {
        setEpicProgressLeaseWaitMsForTests(null);
    }
    assert.ok(redis.locked.length > 1 && redis.locked.every(key => key === LOCK_KEY), 'B polled the lease until its wait ran out');
    assert.equal(redis.keys.get(LOCK_KEY), 'status-writer-A', 'A still holds the lease');
    assert.equal(github.progressComment(), before, 'B wrote nothing without the lease');
    assert.deepEqual(signalled, [EPIC_BRANCH], 'B asked for a fresh epic update instead of leaving its activity to A');
    // A finishes: it writes the older activity it read, fences its own sequence, and releases the lease; it signals nothing.
    github.comments[0].body = buildEpicProgressComment(PROGRESS_AFTER_910, 'Scheduler primitives', undefined, ['In progress: #801 (Second issue)', 'Up next: #802 (Third issue)']);
    await advanceEpicActivityFence(redis, REPOSITORY, EPIC, olderRead);
    redis.keys.delete(LOCK_KEY);
    assert.match(github.progressComment(), WORKING_LINES, 'the comment is stale: it shows A\'s older activity');
    // The fresh update B asked for reads the epic again (the child is ready) and publishes the latest activity.
    const refreshRead = await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC);
    assert.deepEqual(refreshRead, { sequence: 3 });
    await syncEpicProgressCommentForStatus(github as never, redis, { ...target, snapshot: refreshRead }, READY_EPIC_FACTS as never);
    assert.match(github.progressComment(), READY_LINES, 'the scheduled refresh converged the comment to the latest activity');
    assert.equal(redis.leaseKeys().length, 0);
});

test('a status pass that gives up on a held lease asks for nothing when a later pass already wrote newer activity', async () => {
    const redis = new FakeLeaseRedis();
    const target = { repository: REPOSITORY, prNumber: EPIC };
    const olderRead = await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC);
    const newerRead = await claimEpicActivitySnapshot(redis, REPOSITORY, EPIC);
    // The newer pass published already and fenced its sequence; the older pass finds the lease held by yet another writer.
    await advanceEpicActivityFence(redis, REPOSITORY, EPIC, newerRead);
    redis.keys.set(LOCK_KEY, 'merge-writer');
    const before = github.progressComment();
    setEpicProgressLeaseWaitMsForTests(200);
    let signalled: string[];
    try {
        signalled = await recordingEpicSignals(async () =>
            await syncEpicProgressCommentForStatus(github as never, redis, { ...target, snapshot: olderRead }, OPEN_EPIC_FACTS));
    } finally {
        setEpicProgressLeaseWaitMsForTests(null);
    }
    assert.equal(github.progressComment(), before);
    assert.deepEqual(signalled, [], 'its activity is superseded: the comment is already current, so no update is scheduled');
    redis.keys.delete(LOCK_KEY);
});

test('a facts read whose body lock lapsed before it was ordered writes nothing and asks for a fresh epic update', async () => {
    const redis = new FakeLeaseRedis();
    const lost = { assertHeld: async () => { throw new PullRequestBodyLockLostError('x'); } };
    const snapshot = await orderEpicActivityRead(redis, { repository: REPOSITORY, prNumber: EPIC }, OPEN_EPIC_FACTS, lost);
    assert.deepEqual(snapshot, UNORDERED_EPIC_ACTIVITY_SNAPSHOT);
    assert.deepEqual(await orderEpicActivityRead(redis, { repository: REPOSITORY, prNumber: EPIC }, OPEN_EPIC_FACTS, { assertHeld: async () => undefined }), { sequence: 2 });
    assert.deepEqual(await orderEpicActivityRead(null, { repository: REPOSITORY, prNumber: EPIC }, OPEN_EPIC_FACTS, lost), { sequence: null, reason: 'unfenced' },
        'without Redis nothing is ordered, and the write runs as before');
    const before = github.progressComment();
    const signalled: string[] = [];
    setPullRequestStatusEpicSyncRunner({ forBranch: (_repository, branch) => { signalled.push(branch); }, forPlan: () => undefined });
    try {
        await syncEpicSideOfStatus(github as never, redis, { repository: REPOSITORY, prNumber: EPIC },
            { epic: OPEN_EPIC_FACTS, baseRef: 'main', statusChanged: false, status: null, activitySnapshot: snapshot });
    } finally {
        setPullRequestStatusEpicSyncRunner(null);
    }
    assert.equal(github.progressComment(), before, 'an unordered read is never written');
    assert.deepEqual(redis.locked, [], 'and takes no lease');
    assert.deepEqual(signalled, [EPIC_BRANCH], 'the fresh update reads the epic again');
});

// --- an issue stopped on a reported blocker ---

test('a queue head stopped on a reported blocker shows ⚠️, not in progress', async () => {
    await database('plan_issues').where({ issue_number: 801 }).update({ status: 'merged' });
    Object.assign(github.pulls.get(911)!, { state: 'closed', merged: true, merged_at: '2026-11-13T09:00:00Z' });
    await database('plan_issues').where({ issue_number: 802 }).update({ status: 'processing' });
    await database('epic_execution_queues').update({ cursor: 2 });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /🔨 2 of 3 issues merged · #802 in progress · /, 'a running head is in progress');
    await database('epic_execution_queues').update({ blocked_reason: agentBlockedHeadReason(802) });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 2 of 3 issues merged · #802 stopped on a blocker · /);
    assert.match(github.progressComment(), /\nIn progress: #802 \(Third issue\) - stopped on a blocker\n/);
});

test('a pending queue head stopped on a reported blocker is named in the status, not listed up next', async () => {
    // #802's processing webhook was lost: it is the active head, still pending, when its run reports a blocker.
    await database('plan_issues').where({ issue_number: 801 }).update({ status: 'merged' });
    Object.assign(github.pulls.get(911)!, { state: 'closed', merged: true, merged_at: '2026-11-13T09:00:00Z' });
    await database('epic_execution_queues').update({ cursor: 2, blocked_reason: agentBlockedHeadReason(802) });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 2 of 3 issues merged · #802 stopped on a blocker · /);
    assert.match(github.progressComment(), /\nIn progress: #802 \(Third issue\) - stopped on a blocker\n/);
    assert.doesNotMatch(github.progressComment(), /Up next: [^\n]*#802/, 'the blocked issue has started; it is not up next');
});

test('an active queue that is not ready starts nothing, so the epic is not shown working on its next issue', async () => {
    await mergeSubPr911();
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /🔨 2 of 3 issues merged · #802 starts next · /, 'a ready queue is about to start its pending head');
    // startEpicQueueHead dispatches nothing from an unready queue, and advanceEpicQueue does not advance one.
    await database('epic_execution_queues').update({ ready: false });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 2 of 3 issues merged · nothing in progress · /, 'a pending head');
    await database('epic_execution_queues').update({ cursor: 1 });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 2 of 3 issues merged · nothing in progress · /, 'a merged head with an issue still to start');
    await database('epic_execution_queues').update({ ready: true });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /🔨 2 of 3 issues merged · #802 starts next · /, 'once ready, the merged head advances to the pending issue');
});

test('an active parallel execution that is not ready is not shown working on its pending issues', async () => {
    await mergeSubPr911();
    await database('epic_execution_queues').update({ parallel: true, cursor: 0 });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /🔨 2 of 3 issues merged · #802 starts next · /, 'a ready parallel execution has a pending issue to start');
    await database('epic_execution_queues').update({ ready: false });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 2 of 3 issues merged · nothing in progress · /);
});

// --- lists longer than the pages read ---

/** Pull requests closed without merging into the epic branch, from #2000 on: they count for nothing but are listed. */
function addAbandonedSubPrs(count: number): void {
    for (let number = 2000; number < 2000 + count; number++) {
        github.pulls.set(number, pull(number, { state: 'closed', head: { sha: `h${number}`, ref: `x-${number}`, repo: { full_name: REPOSITORY } }, base: { ref: EPIC_BRANCH, sha: 'e1' } }));
    }
}

test('an epic with more pull requests into its branch than the pages read keeps its published status', async () => {
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    const published = { line: statusLine(), title: github.epic().title, comment: github.progressComment() };
    assert.match(published.line, /⚠️ 1 of 3 issues merged · #911 \(issue #801\) waits to be merged/);
    // 1,001 pull requests into the epic branch; the open #911 is listed last, where the ten pages read would miss it.
    const writes = github.writes.length;
    addAbandonedSubPrs(999);
    const open911 = github.pulls.get(911)!;
    github.pulls.delete(911);
    github.pulls.set(911, open911);
    await assert.rejects(syncPullRequestStatus(REPOSITORY, EPIC, deps()), /lists more than 1000 items/);
    assert.equal(github.writes.length, writes, 'nothing is written from a part of the list');
    assert.deepEqual({ line: statusLine(), title: github.epic().title, comment: github.progressComment() }, published);
    // Exactly ten full pages is the whole list: the epic's status is read.
    github.pulls.delete(2998);
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /⚠️ 1 of 3 issues merged · #911 \(issue #801\) waits to be merged/);
});

test('the status pass leaves the progress comment alone when the comments run past the pages read', async () => {
    const before = github.progressComment();
    for (let id = 100; id < 1099; id++) github.comments.push({ id, body: `note ${id}`, user: { login: 'propr-dev[bot]' } });
    // The epic's final-merge confirmation is on the eleventh page.
    github.comments.push({ id: 5000, body: `### ✅ Epic merged\n${EPIC_FINAL_MERGE_MARKER}`, user: { login: 'propr-dev[bot]' } });
    const facts = { merged: 1, total: 3, progress: PROGRESS_AFTER_910, planName: 'Scheduler primitives', epicBranch: EPIC_BRANCH, upNext: [{ issueNumber: 802, title: 'Third issue' }] };
    await syncEpicProgressCommentForStatus(github, null, { repository: REPOSITORY, prNumber: EPIC }, facts as never);
    assert.equal(github.progressComment(), before, 'a confirmation the ten pages did not reach still keeps the comment');
    assert.equal(github.writes.filter(write => write.route.includes('/issues/comments/')).length, 0);
});

// --- sub-PRs beyond the status read budget ---

test('an epic whose unread sub-PRs could be working keeps its published state, with its merged count updated', async () => {
    // #911 is being worked on: the epic is published as working.
    await database('task_history').insert({ task_id: 't-911', state: 'processing' });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    const working = statusLine();
    assert.match(working, /🔨 1 of 3 issues merged · #801 in progress/);
    // Ten more open pull requests into the epic branch: the last one is beyond the read budget.
    for (let number = 920; number < 930; number++) {
        github.pulls.set(number, pull(number, { head: { sha: `h${number}`, ref: `x-${number}`, repo: { full_name: REPOSITORY } }, base: { ref: EPIC_BRANCH, sha: 'e1' } }));
    }
    await database('task_history').insert({ task_id: 't-911', state: 'completed' });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    // Listed without an update time, no read status is kept: no state is claimed from incomplete sub-PR statuses.
    assert.equal(statusLine(), working.replace('1 of 3', '1 of 13'), 'the published state stays; only its merged count changes');
    assert.equal(github.epic().title, '🔨 1/13 [Epic] Scheduler primitives');
    const writes = github.writes.filter(write => write.route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}').length;
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.writes.filter(write => write.route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}').length, writes, 'nothing new: neither the block nor the title is written');
    // Once the unread pull request is gone, the status is known again: #911 waits to be merged (the other PRs count, without ProPR status).
    github.pulls.delete(929);
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /⚠️ 1 of 12 issues merged · #911 \(issue #801\) waits to be merged/);
});

/** Open sub-PRs #920..#(920+count-1) into the epic branch, listed with an update time as GitHub lists them. */
function addListedSubPrs(count: number): void {
    for (let number = 920; number < 920 + count; number++) {
        github.pulls.set(number, pull(number, {
            head: { sha: `h${number}`, ref: `x-${number}`, repo: { full_name: REPOSITORY } }, base: { ref: EPIC_BRANCH, sha: 'e1' },
            updated_at: '2026-11-13T09:00:00Z',
        }));
    }
    github.pulls.get(911)!.updated_at = '2026-11-13T09:00:00Z';
}

function subPrReads(): number {
    return github.reads.filter(number => number !== EPIC).length;
}

test('more open sub-PRs than the read budget: later updates read the rest, keep what was read, and establish the state', async () => {
    await database('task_history').insert({ task_id: 't-911', state: 'processing' });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /🔨 1 of 3 issues merged · #801 in progress/);
    // Twelve open sub-PRs, none working any more: #911 waits to be merged.
    addListedSubPrs(11);
    await database('task_history').insert({ task_id: 't-911', state: 'completed' });
    github.reads = [];
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(subPrReads(), 10, 'one update reads at most ten sub-PRs');
    assert.match(statusLine(), /^\*\*ProPR\*\* 🔨 1 of 14 issues merged · #801 in progress/, 'undetermined: the state stays, the count is updated');
    assert.equal(github.epic().title, '🔨 1/14 [Epic] Scheduler primitives');

    // The next update reads the two left unread and keeps the ten read before: the state is established.
    github.reads = [];
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.ok(github.reads.includes(929) && github.reads.includes(930), 'the sub-PRs left unread are read first');
    assert.equal(subPrReads(), 10);
    assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 1 of 14 issues merged · #911 \(issue #801\) waits to be merged/);
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.equal(github.epic().title, '⚠️ 1/14 [Epic] Scheduler primitives');

    // One sub-PR merges while more than ten stay open: the count follows, and the state stays established.
    Object.assign(github.pulls.get(920)!, { state: 'closed', merged: true, merged_at: '2026-11-13T09:30:00Z' });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 2 of 14 issues merged · #911 \(issue #801\) waits to be merged/);
    assert.equal(github.epic().title, '⚠️ 2/14 [Epic] Scheduler primitives');
});

test('a kept sub-PR status is read again once the sub-PR changes', async () => {
    addListedSubPrs(11);
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /⚠️ 1 of 14 issues merged · #911 \(issue #801\) waits to be merged/);
    // #930 (listed last) starts working; its own status sync rewrites it, which changes its update time.
    await database('tasks').insert({ task_id: 't-930', repository: REPOSITORY, issue_number: 4930, task_type: 'issue', created_at: '2026-11-13T09:40:00Z', initial_job_data: '{}', pr_number: 930 });
    await database('task_history').insert({ task_id: 't-930', state: 'processing' });
    github.pulls.get(930)!.updated_at = '2026-11-13T09:40:00Z';
    github.reads = [];
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.ok(github.reads.includes(930), 'the changed sub-PR is read, not taken from the kept status');
    assert.match(statusLine(), /^\*\*ProPR\*\* 🔨 1 of 14 issues merged · #930/);
});

test('a kept sub-PR status is read again once the sub-PR\'s sync records a change it could not write', async () => {
    titleSetting = false;
    addListedSubPrs(11);
    // #930 is ProPR's and working; its body leaves no room for the block, so its status changes write nothing.
    await database('tasks').insert({ task_id: 't-930', repository: REPOSITORY, issue_number: 4930, task_type: 'issue', created_at: '2026-11-13T09:40:00Z', initial_job_data: '{}', pr_number: 930 });
    await database('task_history').insert({ task_id: 't-930', state: 'processing' });
    github.pulls.get(930)!.body = FULL_BODY;
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /^\*\*ProPR\*\* 🔨 1 of 14 issues merged · #930 in progress/);
    await syncPullRequestStatus(REPOSITORY, 930, deps());

    // #930's run completes: ready. Its sync writes nothing, so GitHub's update time of #930 stays as the epic kept it.
    await database('task_history').insert({ task_id: 't-930', state: 'completed' });
    await syncPullRequestStatus(REPOSITORY, 930, deps());
    assert.equal(subPrPatches(930), 0);
    github.reads = [];
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.ok(github.reads.includes(930), 'the changed sub-PR is read, not taken from the kept status');
    assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 1 of 14 issues merged · #911 \(issue #801\) waits to be merged/);
});

test('an update leaving sub-PRs unread schedules the update that reads them', async () => {
    addListedSubPrs(11);
    setEpicChildReadContinueMsForTests(20);
    enablePullRequestStatusSync(deps());
    try {
        requestPullRequestStatusSync(REPOSITORY, EPIC);
        const deadline = Date.now() + 8_000;
        // No further signal: the scheduled continuation alone establishes the state.
        while (!/⚠️ 1 of 14 issues merged/.test(statusLine()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.match(statusLine(), /⚠️ 1 of 14 issues merged · #911 \(issue #801\) waits to be merged/);
    } finally {
        disablePullRequestStatusSync();
        setEpicChildReadContinueMsForTests(null);
    }
});

test('a working epic that left sub-PRs unread schedules the update that reads them into the progress comment', async () => {
    addListedSubPrs(11);
    // #911, read first, is working: the epic is 🔨 without the two sub-PRs beyond the read budget.
    await database('task_history').insert({ task_id: 't-911', state: 'processing' });
    // #930, listed last and left unread by the first update, is ProPR's and ready to merge.
    await database('tasks').insert({ task_id: 't-930', repository: REPOSITORY, issue_number: 4930, task_type: 'issue', created_at: '2026-11-13T09:40:00Z', initial_job_data: '{}', pr_number: 930 });
    await database('task_history').insert({ task_id: 't-930', state: 'completed' });
    setEpicChildReadContinueMsForTests(20);
    enablePullRequestStatusSync(deps());
    try {
        requestPullRequestStatusSync(REPOSITORY, EPIC);
        const readyLine = /^In progress: [^\n]*#930 \(PR 930\) - ready to merge/m;
        const deadline = Date.now() + 8_000;
        // No further signal: the scheduled continuation alone reads #929 and #930.
        while (!readyLine.test(github.progressComment()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(github.reads.includes(930), 'the sub-PR left unread is read by the continuation');
        assert.match(github.progressComment(), readyLine);
        assert.match(statusLine(), /^\*\*ProPR\*\* 🔨 1 of 14 issues merged · #801 in progress/, 'the epic stays working');
    } finally {
        disablePullRequestStatusSync();
        setEpicChildReadContinueMsForTests(null);
    }
});

test('an epic with more stable sub-PRs than twenty-one updates read is read to the end by the scheduled updates', async () => {
    await database('task_history').insert({ task_id: 't-911', state: 'processing' });
    await syncPullRequestStatus(REPOSITORY, EPIC, deps());
    assert.match(statusLine(), /🔨 1 of 3 issues merged · #801 in progress/, 'the published state is working');
    // 211 open sub-PRs, none changing and none working: the first update and twenty continuations read 210 of them.
    addListedSubPrs(210);
    await database('task_history').insert({ task_id: 't-911', state: 'completed' });
    github.reads = [];
    setEpicChildReadContinueMsForTests(5);
    enablePullRequestStatusSync(deps());
    try {
        requestPullRequestStatusSync(REPOSITORY, EPIC);
        const established = /⚠️ 1 of 213 issues merged/;
        const deadline = Date.now() + 30_000;
        // No further signal: only the scheduled continuations read the sub-PRs.
        while (!established.test(statusLine()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(github.reads.includes(1129), 'the sub-PR listed last is read');
        assert.match(statusLine(), /^\*\*ProPR\*\* ⚠️ 1 of 213 issues merged · #911 \(issue #801\) waits to be merged/);
    } finally {
        disablePullRequestStatusSync();
        setEpicChildReadContinueMsForTests(null);
    }
});
