import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * F44: an agent that exits reporting full success without changing any file
 * (the requested correction was already present) has answered the request.
 * When the worker dies after the successful-exit checkpoint but before the
 * normal no-change completion comment, recovery must deliver that completion
 * once — with the analysis persisted at the checkpoint — and complete the
 * task, never announce an interruption, return the comments to the queue,
 * schedule another follow-up or fail the task. Run over the production git
 * operations, the real store and the real checkpoint hook.
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-no-change-success-'));

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLog; } };
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BRANCH = 'propr/pr-head';
const KEY = { repository: 'acme/widgets', pull_request: 7 };
const LOCK = 'lock:pr:acme:widgets:7';
const ANALYSIS = 'The widget already validates its input; no correction was needed.';

const core = await import('@propr/core');
await mock.module('@propr/core', {
    namedExports: {
        ...core,
        db: database,
        logger: silentLog,
        pushBranch: async () => { throw new Error('a no-change recovery must never push'); },
    },
});
await mock.module('../src/jobs/prContributionDiscussion.js', { namedExports: { loadOriginalContributionDiscussion: async () => undefined } });
after(async () => {
    await database.destroy();
    await core.closeConnection?.();
    await rm(root, { recursive: true, force: true });
});

const { recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff, PR_FOLLOWUP_HANDOFFS_TABLE, HANDOFF_AWAITING_OPERATOR } = await import('../src/jobs/followupHandoffStore.js');
const { recoverInterruptedFollowupHandoffs, adoptPredecessorFollowupHandoff } = await import('../src/jobs/followupHandoffRecovery.js');
const { createFollowupHandoffGitOps } = await import('../src/jobs/followupHandoffGitOps.js');
const { markExecutionHandoffAgentExited } = await import('../src/jobs/prCommentHandoffIntegration.js');
const { noChangeAnalysisSummary } = await import('../src/jobs/prCompletionComment.js');
const { handoffCommentMarker } = await import('../src/jobs/followupHandoffMarker.js');

type HandoffRecord = NonNullable<Awaited<ReturnType<typeof loadFollowupHandoff>>>;
let fixtureIndex = 0;

async function createFixture(): Promise<{ local: string; wt: string }> {
    const dir = path.join(root, `fx-${fixtureIndex++}`);
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '--bare', 'origin.git');
    git(dir, 'clone', 'origin.git', 'local');
    const local = path.join(dir, 'local');
    await writeFile(path.join(local, 'base.txt'), 'base\n');
    git(local, 'add', '.');
    git(local, 'commit', '-m', 'Base');
    git(local, 'branch', '-M', BRANCH);
    git(local, 'push', '-u', 'origin', BRANCH);
    git(local, 'checkout', '--detach');
    const wt = path.join(dir, 'wt');
    git(local, 'worktree', 'add', wt, BRANCH);
    return { local, wt };
}

function createLockRedis() {
    const store = new Map<string, { value: string; ttl: number }>();
    return {
        async set(key: string, value: string, _ex: string, ttl: number, nx?: string) {
            if (nx === 'NX' && store.has(key)) return null;
            store.set(key, { value, ttl: Number(ttl) });
            return 'OK';
        },
        async eval(script: string, _numKeys: number, key: string, ...args: Array<string | number>) {
            const current = store.get(key);
            if (script.includes('ttl')) { // adopt
                const [predecessor, successor, ttlSeconds, floor] = args;
                if (!current) { store.set(key, { value: String(successor), ttl: Number(ttlSeconds) }); return 1; }
                if (current.value !== String(predecessor)) return 0;
                if (current.ttl > Number(floor)) return -1;
                store.set(key, { value: String(successor), ttl: Number(ttlSeconds) });
                return 1;
            }
            if (script.includes('del')) { // release
                if (current?.value === String(args[0])) { store.delete(key); return 1; }
                return 0;
            }
            if (script.includes('expire')) { // renew
                if (current?.value === String(args[0])) { current.ttl = Number(args[1]); return 1; }
                return 0;
            }
            throw new Error('Unknown lock script');
        },
        async quit() { return 'OK'; },
    };
}

interface FakeComment { id: number; body: string; html_url: string }

function createOctokit() {
    const comments: FakeComment[] = [];
    const mutations: string[] = [];
    let nextId = 1000;
    const octokit = {
        comments, mutations,
        /** Lets a test kill the worker right after a comment mutation lands. */
        afterMutation: (() => undefined) as () => void,
        async request(route: string, params?: Record<string, unknown>) {
            if (route.startsWith('GET ') && route.includes('/pulls/')) return { data: { head: { ref: BRANCH }, base: { ref: 'main' } } };
            if (route.startsWith('PATCH ')) {
                const found = comments.find(comment => comment.id === params?.comment_id);
                if (!found) throw Object.assign(new Error('Not Found'), { status: 404 });
                found.body = String(params?.body ?? '');
                mutations.push('PATCH');
                octokit.afterMutation();
                return { data: found };
            }
            if (route.startsWith('POST ')) {
                const created = { id: nextId++, body: String(params?.body ?? ''), html_url: `https://example.test/comment/${nextId}` };
                comments.push(created);
                mutations.push('POST');
                octokit.afterMutation();
                return { data: created };
            }
            throw new Error(`Unexpected request: ${route}`);
        },
        async paginate() { return [...comments]; },
        async auth() { return { token: 'installation-token' }; },
    };
    return octokit;
}

async function createHarness() {
    const fx = await createFixture();
    const states = new Map<string, string>([['task-1', 'processing']]);
    const transitions: string[] = [];
    const stateManager = {
        states, transitions,
        async getTaskState(taskId: string) { return states.has(taskId) ? { state: states.get(taskId)! } : null; },
        async updateTaskState(taskId: string, state: string) { transitions.push(state); states.set(taskId, state); },
        async updateHistoryMetadata() { return undefined; },
    };
    const octokit = createOctokit();
    const restored: number[] = [];
    const scheduled: string[] = [];
    const deps = {
        store: { database }, redis: createLockRedis(), log: silentLog, stateManager,
        getOctokit: async () => octokit,
        inspectLiveness: async () => ({ liveness: 'not_found' }),
        git: createFollowupHandoffGitOps(async () => 'installation-token'),
        restoreComments: async (_record: unknown, claimed: Array<{ id: number }>) => { restored.push(...claimed.map(comment => comment.id)); },
        withdrawRestoredComments: async () => undefined,
        scheduleRestoredComments: async (record: HandoffRecord) => { scheduled.push(record.incarnation); },
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    };
    return { fx, stateManager, octokit, restored, scheduled, deps };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/** The handoff the normal path records, then its real successful-exit checkpoint on a clean, fully pushed worktree. */
async function exitAgent(h: Harness, agentCompleted: boolean): Promise<HandoffRecord> {
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: 'task-1', sourceTaskIds: [], correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local,
        claimedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }],
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-1' } as never,
        llm: 'claude', lockKey: LOCK, lockToken: 'dead-worker-token',
        binding: { headSha: git(h.fx.wt, 'rev-parse', 'HEAD') },
    }, { database });
    assert.ok(record);
    h.octokit.comments.push({ id: 500, body: '🤖 Starting work on the follow-up', html_url: 'https://example.test/comment/500' });
    const linked = await advanceFollowupHandoff({ database }, record, { starting_comment_id: 500 });
    assert.ok(linked);
    const carrier = { followupHandoff: linked };
    await markExecutionHandoffAgentExited(carrier, agentCompleted, agentCompleted ? ANALYSIS : 'stopped-short report');
    return carrier.followupHandoff!;
}

const branchOf = (wt: string) => git(wt, 'branch', '--show-current');

beforeEach(async () => {
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
});

test('F44: a recorded successful no-change run is completed by recovery, never executed again', async () => {
    const h = await createHarness();
    const exited = await exitAgent(h, true);
    assert.equal(exited.agent_summary, ANALYSIS, 'the success analysis is durable before publication');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps as never);
    assert.equal(summary.errors, 0);
    assert.equal(summary.settled, 1, 'reconciled as an answered request');
    assert.equal(summary.noChanges, 0, 'not an interrupted request returned to the queue');
    assert.deepEqual(h.octokit.mutations, ['PATCH'], 'exactly one completion, on the starting comment');
    const body = h.octokit.comments[0].body;
    assert.ok(body.includes(handoffCommentMarker(exited)));
    assert.match(body, /Analyzed the follow-up request/);
    assert.ok(body.includes(ANALYSIS), 'the persisted analysis is the delivered answer');
    assert.doesNotMatch(body, /interrupted before any changes/i);
    assert.match(body, /work-evidence/i, 'the completion carries completed evidence');
    assert.deepEqual(h.restored, [], 'no claimed comment is restored');
    assert.deepEqual(h.scheduled, [], 'no replacement follow-up is scheduled');
    assert.deepEqual(h.stateManager.transitions, ['completed'], 'the task completes, with no failure transition');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined, 'the handoff retires');
    assert.equal(branchOf(h.fx.wt), '', 'the branch is free again');

    const again = await recoverInterruptedFollowupHandoffs(h.deps as never);
    assert.equal(again.inspected, 0, 'a repeated pass finds nothing to do');
    assert.deepEqual(h.octokit.mutations, ['PATCH'], 'and publishes nothing more');
    assert.equal(h.octokit.comments.length, 1);
    assert.deepEqual(h.restored, []);
    assert.deepEqual(h.stateManager.transitions, ['completed']);
});

test('F44: a death right after the recovered completion is delivered resumes without a second comment or requeue', async () => {
    const h = await createHarness();
    await exitAgent(h, true);
    h.octokit.afterMutation = () => { throw new Error('worker killed'); };
    const crashed = await recoverInterruptedFollowupHandoffs(h.deps as never);
    assert.equal(crashed.errors, 1);
    const pending = await loadFollowupHandoff({ database }, KEY);
    assert.equal(pending?.phase, 'agent_exited', 'the delivery was never checkpointed');
    assert.equal(h.stateManager.states.get('task-1'), 'processing');

    h.octokit.afterMutation = () => undefined;
    const resumed = await recoverInterruptedFollowupHandoffs(h.deps as never);
    assert.equal(resumed.settled, 1);
    assert.equal(resumed.noChanges, 0);
    assert.deepEqual(h.octokit.mutations, ['PATCH'], 'the delivered completion is found by its marker, not republished');
    assert.ok(h.octokit.comments[0].body.includes(ANALYSIS));
    assert.deepEqual(h.restored, []);
    assert.deepEqual(h.scheduled, []);
    assert.deepEqual(h.stateManager.transitions, ['completed']);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('F44: a successor adopting the successful no-change predecessor in-line does not requeue its comments', async () => {
    const h = await createHarness();
    await exitAgent(h, true);
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        h.deps as never,
    );
    assert.deepEqual(adoption, { resumed: { outcome: 'settled' } });
    assert.deepEqual(h.octokit.mutations, ['PATCH']);
    assert.deepEqual(h.restored, []);
    assert.deepEqual(h.stateManager.transitions, ['completed']);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('F44: a stopped-short run without changes is still an interrupted request returned to the queue', async () => {
    const h = await createHarness();
    const exited = await exitAgent(h, false);
    assert.equal(exited.agent_summary, null, 'only a full success persists its analysis');
    const summary = await recoverInterruptedFollowupHandoffs(h.deps as never);
    assert.equal(summary.noChanges, 1);
    assert.match(h.octokit.comments[0].body, /interrupted before any changes/i);
    assert.deepEqual(h.restored, [11]);
    assert.equal(h.scheduled.length, 1);
    assert.deepEqual(h.stateManager.transitions, ['failed']);
});

test('F44: a user cancellation still holds a successful no-change run without publishing', async () => {
    const h = await createHarness();
    await exitAgent(h, true);
    h.stateManager.states.set('task-1', 'cancelled');
    const summary = await recoverInterruptedFollowupHandoffs(h.deps as never);
    assert.equal(summary.awaitingOperator, 1);
    assert.deepEqual(h.octokit.mutations, []);
    assert.deepEqual(h.restored, []);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
});

test('F44: the persisted analysis is cleaned exactly as the no-change completion renders it', () => {
    const summary = noChangeAnalysisSummary({
        summary: 'PR: #7\nAlready fixed.\n\n\n\nSee .propr/previews/desktop.png\nDone.',
    } as never);
    assert.equal(summary, 'Already fixed.\n\nSee [local preview omitted]\nDone.');
});
