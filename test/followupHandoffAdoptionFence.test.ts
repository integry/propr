import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * Review 6230432423 F34: in-line predecessor adoption fences the predecessor's
 * normal-path checkpoints. A suspended predecessor whose agent was stopped and
 * whose lease expired can resume its outstanding `agent_exited` checkpoint
 * after the in-line recovery already pushed; that stale write must fail as
 * lost ownership instead of regressing the phase — for a different successor
 * task and for a same-task redelivery sharing the job's persisted lease token.
 *
 * Runs the real in-line adoption, resume, normal checkpoints and production
 * git operations over a real local origin; only GitHub is in memory.
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-adoption-fence-'));

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLog; } };
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BRANCH = 'propr/pr-head';
const KEY = { repository: 'acme/widgets', pull_request: 7 };
const LOCK = 'lock:pr:acme:widgets:7';
const PREDECESSOR_TOKEN = 'job-1-persisted-token';

const core = await import('@propr/core');
await mock.module('@propr/core', {
    namedExports: { ...core, db: database, logger: silentLog },
});
await mock.module('../src/jobs/prContributionDiscussion.js', { namedExports: { loadOriginalContributionDiscussion: async () => undefined } });
after(async () => {
    await database.destroy();
    await core.closeConnection?.();
    await rm(root, { recursive: true, force: true });
});

const { recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff, PR_FOLLOWUP_HANDOFFS_TABLE } = await import('../src/jobs/followupHandoffStore.js');
const { adoptPredecessorFollowupHandoff } = await import('../src/jobs/followupHandoffRecovery.js');
const { createFollowupHandoffGitOps } = await import('../src/jobs/followupHandoffGitOps.js');
const { markExecutionHandoffAgentExited, FollowupHandoffOwnershipLostError } = await import('../src/jobs/prCommentHandoffIntegration.js');

type HandoffRecord = NonNullable<Awaited<ReturnType<typeof loadFollowupHandoff>>>;
let fixtureIndex = 0;

async function createFixture() {
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
    return { dir, local, wt };
}

interface FakeComment { id: number; body: string; html_url: string }

function createOctokit(onMutation: () => Promise<void>) {
    const comments: FakeComment[] = [];
    let nextId = 1000;
    return {
        comments,
        async request(route: string, params?: Record<string, unknown>) {
            if (route.startsWith('GET ') && route.includes('/pulls/')) return { data: { head: { ref: BRANCH }, base: { ref: 'main' } } };
            if (route.startsWith('PATCH ') || route.startsWith('POST ')) await onMutation();
            if (route.startsWith('PATCH ')) {
                const found = comments.find(comment => comment.id === params?.comment_id);
                if (!found) throw Object.assign(new Error('Not Found'), { status: 404 });
                found.body = String(params?.body ?? '');
                return { data: found };
            }
            if (route.startsWith('POST ')) {
                const created = { id: nextId++, body: String(params?.body ?? ''), html_url: `https://example.test/comment/${nextId}` };
                comments.push(created);
                return { data: created };
            }
            throw new Error(`Unexpected request: ${route}`);
        },
        async paginate() { return [...comments]; },
        async auth() { return { token: 'installation-token' }; },
    };
}

/**
 * The predecessor recorded its handoff and launched the agent, which edited
 * the retained worktree; the worker was then suspended right before its
 * `agent_exited` checkpoint, still holding this copy of the row.
 */
async function seedSuspendedPredecessor(fx: Awaited<ReturnType<typeof createFixture>>): Promise<HandoffRecord> {
    const recorded = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: 'task-1', sourceTaskIds: [], correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: fx.wt, localRepoPath: fx.local,
        claimedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }] as never,
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets' } as never, llm: 'claude',
        lockKey: LOCK, lockToken: PREDECESSOR_TOKEN,
        binding: { headSha: git(fx.wt, 'rev-parse', 'HEAD') },
    }, { database });
    assert.ok(recorded);
    const linked = await advanceFollowupHandoff({ database }, recorded, { starting_comment_id: 500, container_id: 'container-1' });
    assert.ok(linked);
    await writeFile(path.join(fx.wt, 'widget.txt'), 'fixed\n');
    return linked;
}

async function runScenario(successor: { taskId: string; lockToken: string }) {
    const fx = await createFixture();
    const predecessor = await seedSuspendedPredecessor(fx);
    const stale = { followupHandoff: predecessor } as { followupHandoff?: HandoffRecord | null; followupHandoffOwnershipLost?: boolean };
    let staleCheckpoint: { error?: unknown; phaseAfter?: string } | undefined;
    // The predecessor resumes its outstanding checkpoint once the in-line
    // recovery has pushed, right before it publishes the completion comment.
    const octokit = createOctokit(async () => {
        const current = await loadFollowupHandoff({ database }, KEY);
        if (staleCheckpoint || current?.phase !== 'pushed') return;
        staleCheckpoint = {};
        try {
            await markExecutionHandoffAgentExited(stale as never, true);
        } catch (error) {
            staleCheckpoint.error = error;
        }
        staleCheckpoint.phaseAfter = (await loadFollowupHandoff({ database }, KEY))?.phase;
    });
    octokit.comments.push({ id: 500, body: '🤖 Starting work on the follow-up', html_url: 'https://example.test/comment/500' });
    const states = new Map<string, string>([['task-1', 'processing']]);
    const realGit = createFollowupHandoffGitOps(async () => 'installation-token');
    let pushes = 0;
    const deps = {
        store: { database }, redis: { quit: async () => 'OK' }, log: silentLog,
        stateManager: {
            async getTaskState(taskId: string) { return states.has(taskId) ? { state: states.get(taskId)! } : null; },
            async updateTaskState(taskId: string, state: string) { states.set(taskId, state); },
            async updateHistoryMetadata() { return undefined; },
        },
        getOctokit: async () => octokit,
        inspectLiveness: async () => ({ liveness: 'not_found' }),
        git: {
            ...realGit,
            // The production push authenticates against GitHub; the local origin needs none.
            async push(worktreePath: string) {
                git(worktreePath, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
                pushes += 1;
                return { commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
            },
        },
        restoreComments: async () => { throw new Error('pushed work must never be restored as unaddressed'); },
        withdrawRestoredComments: async () => undefined,
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    };
    const originBefore = git(path.join(fx.dir, 'origin.git'), 'rev-parse', BRANCH);
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: successor.taskId, log: silentLog, lockToken: successor.lockToken },
        deps as never,
    );
    return { fx, adoption, stale, staleCheckpoint, octokit, originBefore, pushes };
}

beforeEach(async () => {
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
});

for (const successor of [
    { name: 'a different successor task', taskId: 'task-2', lockToken: 'task-2-token' },
    { name: 'a same-task redelivery sharing the persisted lease token', taskId: 'task-1', lockToken: PREDECESSOR_TOKEN },
]) {
    test(`F34: a stale agent_exited checkpoint after in-line recovery pushed fails as lost ownership (${successor.name})`, async () => {
        const { fx, adoption, stale, staleCheckpoint, octokit, originBefore, pushes } = await runScenario(successor);
        assert.ok(staleCheckpoint, 'the stale checkpoint ran once recovery reached pushed');
        assert.ok(staleCheckpoint.error instanceof FollowupHandoffOwnershipLostError, 'the predecessor observes that the adoption changed the owner');
        assert.equal(staleCheckpoint.phaseAfter, 'pushed', 'the pushed phase is not regressed to agent_exited');
        assert.equal(stale.followupHandoffOwnershipLost, true);
        assert.equal(stale.followupHandoff, null);

        assert.equal('resumed' in adoption && adoption.resumed?.outcome, 'published', 'recovery finishes its own publication instead of being superseded');
        const origin = path.join(fx.dir, 'origin.git');
        assert.equal(git(origin, 'rev-list', '--count', `${originBefore}..${BRANCH}`), '1', 'exactly one recovery commit was pushed');
        assert.equal(pushes, 1);
        assert.equal(octokit.comments.length, 1, 'no interruption notice or second comment is published');
        assert.match(octokit.comments[0].body, /Recovered and published follow-up changes/);
        assert.equal(await loadFollowupHandoff({ database }, KEY), undefined, 'the delivered handoff retired');
    });
}
