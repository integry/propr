import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A plan issue shows refinement only while follow-up work for its PR is queued
 * or running. These tests drive the real task lifecycle (WorkerStateManager),
 * the real comment tracking handlers and the real plan issue manager against a
 * migrated SQLite database; only Redis and the BullMQ queue are in memory.
 */

const root = await mkdtemp(path.join(tmpdir(), 'plan-refinement-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';

const redisValues = new Map<string, string>();
const redisLists = new Map<string, string[]>();
function FakeRedis() {
    return {
        on: () => {},
        get: async (key: string) => redisValues.get(key) ?? null,
        setex: async (key: string, _ttl: number, value: string) => { redisValues.set(key, value); return 'OK'; },
        set: async (key: string, value: string, ..._args: unknown[]) => {
            if (redisValues.has(key)) return null;
            redisValues.set(key, value);
            return 'OK';
        },
        // The worker state compare-and-set script: write only when the value is unchanged.
        eval: async (_script: string, _keys: number, key: string, expected: string, _ttl: string, next: string) => {
            if (redisValues.get(key) !== expected) return 0;
            redisValues.set(key, next);
            return 1;
        },
        llen: async (key: string) => redisLists.get(key)?.length ?? 0,
        keys: async () => [],
        del: async (key: string) => { redisValues.delete(key); return 1; },
        quit: async () => 'OK',
        disconnect: () => {},
    };
}
await mock.module('ioredis', { namedExports: { Redis: FakeRedis } });

type FakeJob = { id: string; name: string; data: Record<string, unknown>; state: string; processedOn?: number };
let queueJobs: FakeJob[] = [];
let queueReads = 0;
const fakeQueue = { getJobs: async (states: string[]) => { queueReads++; return queueJobs.filter(job => states.includes(job.state)); } };
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: {
    GITHUB_ISSUE_QUEUE_NAME: 'test-issues', COMMENT_BATCH_DELAY_MS: 3000, INDEXING_QUEUE_NAME: 'test-indexing',
    getIssueQueue: async () => fakeQueue, getIndexingQueue: async () => fakeQueue,
    issueQueue: fakeQueue, indexingQueue: fakeQueue,
    createWorker: async () => { throw new Error('not used'); }, shutdownQueue: async () => {},
} });

const activity: Array<Record<string, unknown>> = [];
const publisher = {
    publishActivity: async (payload: Record<string, unknown>) => { activity.push(payload); return true; },
    publishTaskUpdate: async () => true,
    publishDraftUpdate: async () => true,
};
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => publisher, closeEventPublisher: async () => {}, publishNotificationUpdateThroughRedis: () => {}, EventPublisher: class {} },
});

const { db, runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { WorkerStateManager, TaskStates } = await import('../packages/core/src/utils/workerStateManager.js');
const { PlanIssueStatus } = await import('../packages/core/src/config/planIssueManager.js');
const { reconcilePlanIssueRefinement, syncPlanRefinementForPullRequest, syncPlanRefinementForJob } = await import('../packages/core/src/services/taskPlanning/planRefinementSettlement.js');
const { handlePlanPRCommentTracking, handlePlanPRCommentActivity, handlePlanPRUpdate } = await import('../packages/core/src/webhook/planIssueTracking.js');
const { getPendingPrCommentsKey } = await import('../packages/core/src/utils/constants.js');

// The plan issues endpoint, served from this database through the real core exports.
await mock.module('@propr/core', { namedExports: { ...await import('../packages/core/src/index.ts') } });
const { createGetIssuesHandler } = await import('../packages/api/routes/planIssueHandlers.ts');

await runMigrations();
const stateManager = new WorkerStateManager({ keyPrefix: 'test:plan-refinement:' });

after(async () => {
    await stateManager.close();
    await closeConnection();
    await rm(root, { recursive: true, force: true });
});

const OWNER = 'propr-ultrafix';
const REPO = 'propr-desktop-acceptance';
const REPOSITORY = `${OWNER}/${REPO}`;
const DRAFT = 'draft-refinement';
const ISSUE = 9;
const PR = 10;

beforeEach(async () => {
    await db('task_history').delete();
    await db('tasks').delete();
    await db('plan_issues').delete();
    await db('task_drafts').delete();
    redisValues.clear();
    redisLists.clear();
    queueJobs = [];
    activity.length = 0;
    await db('task_drafts').insert({ draft_id: DRAFT, user_id: 'user-1', repository: REPOSITORY, initial_prompt: 'Plan', status: 'pr_created' });
});

async function seedPlanIssue(status: string, followups = 2): Promise<number> {
    const [id] = await db('plan_issues').insert({
        draft_id: DRAFT, repository: REPOSITORY, issue_number: ISSUE, pr_number: PR,
        status, followup_count: followups, task_id: 'issue-task-9',
    });
    return Number(id);
}

async function planIssue() {
    return db('plan_issues').where({ draft_id: DRAFT, issue_number: ISSUE }).first();
}

async function startFollowUp(taskId: string, jobId: string) {
    queueJobs.push({ id: jobId, name: 'processPullRequestComment', data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR }, state: 'active' });
    await stateManager.createTaskStateIfAbsent(taskId, { number: PR, pullRequestNumber: PR, repoOwner: OWNER, repoName: REPO, type: 'pr-comment' }, null, jobId);
    await stateManager.updateTaskState(taskId, TaskStates.PROCESSING);
}

/** The worker returning: BullMQ drops the job once the processor resolves. */
function finishJob(jobId: string) {
    queueJobs = queueJobs.filter(job => job.id !== jobId);
}

function comment(login = 'reviewer', action = 'created') {
    return {
        action,
        repository: { full_name: REPOSITORY },
        issue: { number: PR, pull_request: {} },
        comment: { id: 1, user: { login } },
    } as never;
}

describe('task lifecycle settles plan refinement', () => {
    test('a completed follow-up that made no commit returns the issue to under review', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-a', 'job-a');
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'running follow-up stays refining');

        // The task records completion while BullMQ still lists its job as active.
        await stateManager.updateTaskState('pr-comment-10-a', TaskStates.COMPLETED, { reason: 'No changes were needed' });
        finishJob('job-a');

        const issue = await planIssue();
        assert.equal(issue.status, PlanIssueStatus.UNDER_REVIEW);
        assert.equal(issue.pr_number, PR, 'PR link kept');
        assert.equal(issue.followup_count, 2, 'follow-up count kept');
        assert.equal(issue.task_id, 'issue-task-9', 'task link kept');
        assert.equal((await db('task_drafts').where({ draft_id: DRAFT }).first()).status, 'pr_created', 'plan still shows its open PR');
        assert.deepEqual((await db('task_history').where({ task_id: 'pr-comment-10-a' }).orderBy('history_id')).map(row => row.state),
            ['pending', 'processing', 'completed'], 'task history untouched');
        assert.ok(activity.some(event => event.domain === 'plan' && event.repository === REPOSITORY), 'plan activity published');
    });

    test('refinement_processing after a pushed commit settles the same way', async () => {
        await seedPlanIssue(PlanIssueStatus.REFINEMENT_PROCESSING);
        await startFollowUp('pr-comment-10-b', 'job-b');
        await stateManager.updateTaskState('pr-comment-10-b', TaskStates.COMPLETED);
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('an older run finishing keeps refinement while a newer follow-up is running', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-old', 'job-old');
        await startFollowUp('pr-comment-10-new', 'job-new');

        await stateManager.updateTaskState('pr-comment-10-old', TaskStates.COMPLETED);
        finishJob('job-old');
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'newer run still active');

        await stateManager.updateTaskState('pr-comment-10-new', TaskStates.COMPLETED);
        finishJob('job-new');
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('a queued follow-up or comments waiting behind the run keep refinement', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-c', 'job-c');
        queueJobs.push({ id: 'job-queued', name: 'processPullRequestComment', data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR }, state: 'delayed' });
        await stateManager.updateTaskState('pr-comment-10-c', TaskStates.COMPLETED);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'delayed job is queued work');

        queueJobs = [];
        await startFollowUp('pr-comment-10-d', 'job-d');
        redisLists.set(getPendingPrCommentsKey(OWNER, REPO, PR), ['{"id":2}']);
        await stateManager.updateTaskState('pr-comment-10-d', TaskStates.COMPLETED);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'pending comments are queued work');
    });

    test('failed and cancelled follow-ups stop refinement', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-f', 'job-f');
        await stateManager.markTaskFailed('pr-comment-10-f', new Error('agent crashed'));
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);

        await db('plan_issues').update({ status: PlanIssueStatus.IN_REFINEMENT });
        await startFollowUp('pr-comment-10-x', 'job-x');
        await stateManager.markTaskCancelled('pr-comment-10-x', 'user');
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('a review-only run settles too', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await stateManager.createTaskStateIfAbsent('review-10', { number: PR, repoOwner: OWNER, repoName: REPO, type: 'review' }, null, 'job-review');
        await stateManager.updateTaskState('review-10', TaskStates.COMPLETED);
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('a late completion never downgrades a merged or closed issue', async () => {
        for (const terminal of [PlanIssueStatus.MERGED, PlanIssueStatus.CLOSED]) {
            await db('plan_issues').delete();
            await seedPlanIssue(terminal);
            await startFollowUp(`pr-comment-10-${terminal}`, `job-${terminal}`);
            await stateManager.updateTaskState(`pr-comment-10-${terminal}`, TaskStates.COMPLETED);
            assert.equal((await planIssue()).status, terminal);
            assert.deepEqual(await reconcilePlanIssueRefinement([await planIssue()]), [await planIssue()]);
        }
    });

    test('a delayed synchronize after settlement does not reopen refinement', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-s', 'job-s');
        await stateManager.updateTaskState('pr-comment-10-s', TaskStates.COMPLETED);
        finishJob('job-s');
        await handlePlanPRUpdate({ action: 'synchronize', repository: { full_name: REPOSITORY }, pull_request: { number: PR, title: 'Fix', body: 'Fixes #9', merged: false } } as never, 'sync');
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });
});

describe('PR comments refine only when they admit work', () => {
    test('an ordinary comment that admitted no work counts as a follow-up but never refines', async () => {
        await seedPlanIssue(PlanIssueStatus.UNDER_REVIEW, 0);
        await handlePlanPRCommentTracking(comment(), 'issue_comment', 'c1');
        // The comment handler admitted nothing: no job, no task, no pending comments.
        await handlePlanPRCommentActivity(comment(), 'issue_comment', 'c1');
        const issue = await planIssue();
        assert.equal(issue.status, PlanIssueStatus.UNDER_REVIEW);
        assert.equal(issue.followup_count, 1);
    });

    test('a comment that queued a follow-up job marks the plan refining until the run ends', async () => {
        await seedPlanIssue(PlanIssueStatus.UNDER_REVIEW, 0);
        await handlePlanPRCommentTracking(comment(), 'issue_comment', 'c2');
        queueJobs.push({ id: 'job-admitted', name: 'processPullRequestComment', data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR }, state: 'delayed' });
        await handlePlanPRCommentActivity(comment(), 'issue_comment', 'c2');
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);

        queueJobs = [];
        await startFollowUp('pr-comment-10-admitted', 'job-admitted');
        await stateManager.updateTaskState('pr-comment-10-admitted', TaskStates.COMPLETED);
        finishJob('job-admitted');
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('an ignored comment while a follow-up runs keeps refinement', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await startFollowUp('pr-comment-10-busy', 'job-busy');
        await handlePlanPRCommentActivity(comment(), 'issue_comment', 'c3');
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);
    });

    test('bot comments and comments on merged or closed PRs change nothing', async () => {
        await seedPlanIssue(PlanIssueStatus.MERGED, 0);
        queueJobs.push({ id: 'job-late', name: 'processPullRequestComment', data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR }, state: 'delayed' });
        await handlePlanPRCommentTracking(comment(), 'issue_comment', 'c4');
        await handlePlanPRCommentActivity(comment(), 'issue_comment', 'c4');
        assert.deepEqual([(await planIssue()).status, (await planIssue()).followup_count], [PlanIssueStatus.MERGED, 0]);

        await db('plan_issues').update({ status: PlanIssueStatus.UNDER_REVIEW });
        await handlePlanPRCommentTracking(comment('propr-dev[bot]'), 'issue_comment', 'c5');
        await handlePlanPRCommentActivity(comment('propr-dev[bot]'), 'issue_comment', 'c5');
        assert.deepEqual([(await planIssue()).status, (await planIssue()).followup_count], [PlanIssueStatus.UNDER_REVIEW, 0]);
    });
});

describe('read-path recovery of stale refinement', () => {
    test('an issue left refining with only finished tasks is settled when read, once', async () => {
        const id = await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        // Historical records: the issue task and a completed PR comment task, written before this fix.
        await db('tasks').insert([
            { task_id: 'issue-task-9', repository: REPOSITORY, issue_number: ISSUE, pr_number: PR, task_type: 'issue' },
            { task_id: 'pr-comment-10-old', repository: REPOSITORY, issue_number: PR, task_type: 'issue' },
        ]);
        await db('task_history').insert([
            { task_id: 'issue-task-9', state: 'completed', reason: 'done' },
            { task_id: 'pr-comment-10-old', state: 'completed', reason: 'done' },
        ]);

        const [read] = await reconcilePlanIssueRefinement(await db('plan_issues').where({ id }));
        assert.equal(read.status, PlanIssueStatus.UNDER_REVIEW);
        const stored = await planIssue();
        assert.deepEqual([stored.status, stored.pr_number, stored.followup_count], [PlanIssueStatus.UNDER_REVIEW, PR, 2]);
        assert.equal(await db('task_history').count({ count: '*' }).first().then(row => Number(row?.count)), 2, 'history untouched');

        // Once settled the issue is no longer a candidate: the next read does no work.
        queueReads = 0;
        await reconcilePlanIssueRefinement([stored]);
        assert.equal(queueReads, 0);
    });

    test('an issue whose historical PR task is still running stays refining', async () => {
        const id = await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await db('tasks').insert({ task_id: 'pr-comment-10-live', repository: REPOSITORY, issue_number: PR, task_type: 'issue' });
        await db('task_history').insert({ task_id: 'pr-comment-10-live', state: 'claude_execution', reason: 'running' });
        const [read] = await reconcilePlanIssueRefinement(await db('plan_issues').where({ id }));
        assert.equal(read.status, PlanIssueStatus.IN_REFINEMENT);
    });

    test('an unreadable queue keeps the current status rather than guessing', async () => {
        const id = await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        const [read] = await reconcilePlanIssueRefinement(await db('plan_issues').where({ id }), {
            listQueuedJobs: async () => { throw new Error('redis down'); },
        });
        assert.equal(read.status, PlanIssueStatus.IN_REFINEMENT);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);
    });
});

const followUpJob = (id: string, state: string, processedOn?: number): FakeJob =>
    ({ id, name: 'processPullRequestComment', data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR }, state, processedOn });

describe('work admitted while refinement is being settled', () => {
    /**
     * The read path has found no task and no queued job, and is reading the
     * pending comments. Meanwhile a PR comment admits a delayed follow-up and
     * its webhook synchronizes: the issue is still in_refinement, so marking it
     * changes nothing. The read then resumes with its idle result.
     */
    function admitDuringPendingCommentRead() {
        let admitted = false;
        return {
            countPendingComments: async () => {
                if (!admitted) {
                    admitted = true;
                    queueJobs.push(followUpJob('job-late-comment', 'delayed'));
                    await handlePlanPRCommentActivity(comment(), 'issue_comment', 'late');
                    assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'the webhook mark found nothing to change');
                }
                return 0;
            },
        };
    }

    test('a read-path settlement that raced a newly queued follow-up restores refinement', async () => {
        const id = await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        const [read] = await reconcilePlanIssueRefinement(await db('plan_issues').where({ id }), admitDuringPendingCommentRead());
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'queued follow-up keeps the issue refining');
        assert.equal(read.status, PlanIssueStatus.IN_REFINEMENT, 'the read reports the stored status');
        assert.deepEqual(activity.filter(event => event.domain === 'plan').map(event => event.change), ['blocked', 'created'],
            'the list is told about the settlement and the restore');

        // When that follow-up ends, the issue settles for good.
        queueJobs = [];
        assert.equal((await reconcilePlanIssueRefinement([await planIssue()]))[0].status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('a comment sync that raced a newly queued follow-up restores refinement', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await syncPlanRefinementForPullRequest(REPOSITORY, PR, admitDuringPendingCommentRead());
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);
    });

    test('work that ends before the comment sync marks the issue does not leave it refining', async () => {
        await seedPlanIssue(PlanIssueStatus.UNDER_REVIEW, 0);
        let reads = 0;
        // The first scan still lists the admitted job; it finishes (and its own settlement finds
        // the issue under review, so settles nothing) before the mark is written.
        await syncPlanRefinementForPullRequest(REPOSITORY, PR, {
            listQueuedJobs: async () => (reads++ === 0 ? [followUpJob('job-brief', 'waiting')] : []),
        });
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('a retry that completes while refinement is being restored still settles the issue', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        const firstAttempt = Date.now() - 60_000;
        await stateManager.createTaskStateIfAbsent('job-race', { number: PR, pullRequestNumber: PR, repoOwner: OWNER, repoName: REPO, type: 'pr-comment' }, null, 'job-race');
        await stateManager.updateTaskState('job-race', TaskStates.PROCESSING);
        await stateManager.markTaskFailed('job-race', new Error('agent crashed'));
        await db('plan_issues').update({ status: PlanIssueStatus.IN_REFINEMENT });
        queueJobs = [followUpJob('job-race', 'active', firstAttempt)];

        let reads = 0;
        await syncPlanRefinementForJob(queueJobs[0].data, {
            listQueuedJobs: async () => {
                const read = reads++;
                // The settlement write lands, then BullMQ resumes the retry before the recheck.
                if (read === 1) queueJobs = [followUpJob('job-race', 'active', Date.now() + 1_000)];
                const snapshot = queueJobs.filter(job => job.state !== 'completed').map(job => ({ ...job }));
                if (read === 1) {
                    // The recheck has seen the resumed retry; it completes before the restoration is
                    // written, and its completion sync finds the issue under review with nothing left.
                    queueJobs = [followUpJob('job-race', 'completed', Date.now() + 1_000)];
                    await syncPlanRefinementForJob(queueJobs[0].data);
                    assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW, 'the completion sync had nothing to settle');
                }
                return snapshot;
            },
        });

        assert.ok(reads > 2, 'the restoration looked at the work again');
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW, 'settled without a list read');
        assert.equal(activity.filter(event => event.domain === 'plan').at(-1)?.change, 'blocked', 'the list is told the issue is in review');
    });

    test('a merge recorded while settling is never reopened by the recheck', async () => {
        const id = await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        let reads = 0;
        await reconcilePlanIssueRefinement(await db('plan_issues').where({ id }), {
            countPendingComments: async () => {
                // The second read is the recheck after the settlement write.
                if (reads++ === 1) {
                    await db('plan_issues').where({ id }).update({ status: PlanIssueStatus.MERGED });
                    queueJobs.push(followUpJob('job-after-merge', 'delayed'));
                }
                return 0;
            },
        });
        assert.equal((await planIssue()).status, PlanIssueStatus.MERGED);
    });

    test('a recheck that cannot be read keeps refinement', async () => {
        const id = await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        let reads = 0;
        await reconcilePlanIssueRefinement(await db('plan_issues').where({ id }), {
            countPendingComments: async () => {
                if (reads++ === 1) throw new Error('redis down');
                return 0;
            },
        });
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);
    });
});

describe('BullMQ retries of a failed follow-up', () => {
    test('a delayed retry and its resumed attempt keep the issue refining until the last attempt fails', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        const firstAttempt = Date.now() - 60_000;
        await stateManager.createTaskStateIfAbsent('job-retry', { number: PR, pullRequestNumber: PR, repoOwner: OWNER, repoName: REPO, type: 'pr-comment' }, null, 'job-retry');
        queueJobs.push(followUpJob('job-retry', 'active', firstAttempt));
        await stateManager.updateTaskState('job-retry', TaskStates.PROCESSING);

        // Attempt 1 records the failure while BullMQ still lists it as active: it is wrapping up.
        await stateManager.markTaskFailed('job-retry', new Error('agent crashed'));
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);

        // BullMQ moves the job to delayed for its retry, then emits failed.
        queueJobs = [followUpJob('job-retry', 'delayed', firstAttempt)];
        await syncPlanRefinementForJob(queueJobs[0].data);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'a delayed retry is queued work');
        assert.equal((await reconcilePlanIssueRefinement([await planIssue()]))[0].status, PlanIssueStatus.IN_REFINEMENT);

        // The retry resumes. Its task stays failed (a failed task only resumes on request), but the
        // attempt started after that failure, so it is running work, not the old attempt wrapping up.
        queueJobs = [followUpJob('job-retry', 'active', Date.now() + 1_000)];
        await syncPlanRefinementForJob(queueJobs[0].data);
        assert.equal((await reconcilePlanIssueRefinement([await planIssue()]))[0].status, PlanIssueStatus.IN_REFINEMENT,
            'a resumed retry is not shown as in review');
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);

        // A resumed attempt also brings back refinement that a read settled while it was delayed.
        await db('plan_issues').update({ status: PlanIssueStatus.UNDER_REVIEW });
        await syncPlanRefinementForJob(queueJobs[0].data);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);

        // The last attempt fails for good: BullMQ moves the job to failed.
        queueJobs = [followUpJob('job-retry', 'failed', Date.now() + 1_000)];
        await syncPlanRefinementForJob(queueJobs[0].data);
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
    });

    test('a resumed retry that succeeds settles the issue when its job completes', async () => {
        await seedPlanIssue(PlanIssueStatus.IN_REFINEMENT);
        await stateManager.createTaskStateIfAbsent('job-retry-ok', { number: PR, pullRequestNumber: PR, repoOwner: OWNER, repoName: REPO, type: 'pr-comment' }, null, 'job-retry-ok');
        queueJobs.push(followUpJob('job-retry-ok', 'active', Date.now() - 60_000));
        await stateManager.updateTaskState('job-retry-ok', TaskStates.PROCESSING);
        await stateManager.markTaskFailed('job-retry-ok', new Error('agent crashed'));
        queueJobs = [followUpJob('job-retry-ok', 'delayed')];
        await syncPlanRefinementForJob(queueJobs[0].data);
        queueJobs = [followUpJob('job-retry-ok', 'active', Date.now() + 1_000)];
        await syncPlanRefinementForJob(queueJobs[0].data);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT, 'the resumed retry is running');

        // The retry succeeds, but its task keeps the recorded failure: an automatic retry is not a
        // requested continuation, so the terminal guard refuses the transition and no settlement runs.
        const task = await stateManager.updateTaskState('job-retry-ok', TaskStates.COMPLETED, { reason: 'No changes were needed' });
        assert.equal(task.state, TaskStates.FAILED);
        assert.equal((await planIssue()).status, PlanIssueStatus.IN_REFINEMENT);

        // BullMQ moves the job to completed, then emits completed, which synchronizes the plan.
        activity.length = 0;
        queueReads = 0;
        queueJobs = [followUpJob('job-retry-ok', 'completed', Date.now() + 1_000)];
        await syncPlanRefinementForJob(queueJobs[0].data);
        assert.equal((await planIssue()).status, PlanIssueStatus.UNDER_REVIEW);
        assert.deepEqual(activity.filter(event => event.domain === 'plan' && event.repository === REPOSITORY).map(event => event.change), ['blocked'],
            'the connected list is told without reading the plan issues');
        assert.ok(queueReads > 0, 'settled from the queue, not from a list read');
        assert.deepEqual((await db('task_history').where({ task_id: 'job-retry-ok' }).orderBy('history_id')).map(row => row.state),
            ['pending', 'processing', 'failed'], 'the task record is left as the guard keeps it');
    });

    test('a retry never reopens a merged or closed issue', async () => {
        for (const terminal of [PlanIssueStatus.MERGED, PlanIssueStatus.CLOSED]) {
            await db('plan_issues').delete();
            await seedPlanIssue(terminal);
            queueJobs = [followUpJob('job-retry', 'delayed')];
            await syncPlanRefinementForJob(queueJobs[0].data);
            assert.equal((await planIssue()).status, terminal);
        }
    });
});

describe('plan issues endpoint', () => {
    function createResponse() {
        return {
            statusCode: 200, body: undefined as unknown,
            status(code: number) { this.statusCode = code; return this; },
            json(payload: unknown) { this.body = payload; return this; },
        };
    }

    async function getIssues(query: Record<string, string>) {
        const handler = createGetIssuesHandler({ verifyOwnership: async () => ({ authorized: true }) } as never);
        const res = createResponse();
        await handler({ params: { id: DRAFT }, query, user: { id: 'user-1' } } as never, res as never);
        assert.equal(res.statusCode, 200);
        return res.body as { issues: Array<{ issue_number: number; status: string }>; total: number };
    }

    test('stale refinement is settled before the status filter and pages are applied', async () => {
        // Four issues left refining with no follow-up work, and one PR still being refined.
        for (const n of [1, 2, 3, 4, 5]) {
            await db('plan_issues').insert({ draft_id: DRAFT, repository: REPOSITORY, issue_number: n, pr_number: 100 + n, status: PlanIssueStatus.IN_REFINEMENT });
        }
        queueJobs.push({ ...followUpJob('job-105', 'waiting'), data: { repoOwner: OWNER, repoName: REPO, pullRequestNumber: 105 } });

        const refiningFirst = await getIssues({ page: '0', limit: '2', status: PlanIssueStatus.IN_REFINEMENT });
        assert.deepEqual(refiningFirst.issues.map(issue => [issue.issue_number, issue.status]), [[5, PlanIssueStatus.IN_REFINEMENT]],
            'the page holds only issues that still match the filter');
        assert.equal(refiningFirst.total, 1);
        assert.deepEqual((await getIssues({ page: '1', limit: '2', status: PlanIssueStatus.IN_REFINEMENT })).issues, []);

        // Consecutive pages under the settled status return every settled issue exactly once.
        const pages = [
            await getIssues({ page: '0', limit: '2', status: PlanIssueStatus.UNDER_REVIEW }),
            await getIssues({ page: '1', limit: '2', status: PlanIssueStatus.UNDER_REVIEW }),
        ];
        assert.deepEqual(pages.map(page => page.total), [4, 4]);
        assert.deepEqual(pages.flatMap(page => page.issues.map(issue => issue.issue_number)).sort(), [1, 2, 3, 4]);
    });
});
