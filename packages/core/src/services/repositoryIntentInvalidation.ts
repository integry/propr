import type { Redis } from 'ioredis';
import { formatTaskTerminalReason } from '@propr/shared';
import { db } from '../db/connection.js';
import { getIssueQueue } from '../queue/taskQueue.js';
import logger from '../utils/logger.js';
import { clearUltrafixLoopState } from '../webhook/checkRunHelpers.js';
import { INTENT_JOB_NAMES, PENDING_INTENT_JOB_STATES, jobIntentTarget, nonTerminalTasks, redisAdapter } from './intentScan.js';
import { stopTaskExecution } from './taskCancellation.js';
import { intentJobTaskId, taskIntentTarget, type IntentTarget } from './taskIntent.js';
import { WITHDRAWAL_CLEANUP_KEY, type CleanupRedis } from './withdrawalCleanup.js';

/**
 * Repository-scoped task-intent invalidation that needs no GitHub access, for a
 * repository the installation can no longer read or that left the
 * configuration. Its durable work can never be checked against GitHub again, so
 * every nonterminal intent is cancelled locally and the result is verified.
 */

export const REPOSITORY_UNAVAILABLE_REASON = 'cancelled_repository_unavailable';

const repositoryOf = (target: { repoOwner: string; repoName: string }) => `${target.repoOwner}/${target.repoName}`;
const sameRepository = (target: IntentTarget, repository: string) => repositoryOf(target).toLowerCase() === repository.toLowerCase();

function retainedCleanupTargets(members: string[]): IntentTarget[] {
    return members.flatMap(member => {
        try {
            const target = taskIntentTarget(JSON.parse(member) as Record<string, unknown>, 'issue');
            return target ? [target] : [];
        } catch {
            return [];
        }
    });
}

/**
 * Repositories referenced by nonterminal durable work: task states, queued and
 * active intent jobs, and retained withdrawal cleanups. Read failures (including
 * an unreadable task-state record) propagate, so a caller never mistakes a
 * partial scan for the complete set.
 */
export async function listIntentRepositories(redis: CleanupRedis): Promise<string[]> {
    const repositories = new Set<string>();
    const add = (target: IntentTarget | null) => { if (target) repositories.add(repositoryOf(target)); };
    for await (const task of nonTerminalTasks({ strict: true })) add(taskIntentTarget(task.issueRef, task.issueRef.type));
    for (const job of await (await getIssueQueue()).getJobs(PENDING_INTENT_JOB_STATES)) {
        if (INTENT_JOB_NAMES.includes(job.name)) add(jobIntentTarget(job));
    }
    retainedCleanupTargets(await redis.smembers(WITHDRAWAL_CLEANUP_KEY)).forEach(add);
    return [...repositories];
}

interface Candidate { taskId: string; target: IntentTarget }

async function collectCandidates(repository: string): Promise<Map<string, Candidate>> {
    const candidates = new Map<string, Candidate>();
    for await (const task of nonTerminalTasks({ strict: true })) {
        const target = taskIntentTarget(task.issueRef, task.issueRef.type);
        if (target && sameRepository(target, repository)) candidates.set(task.taskId, { taskId: task.taskId, target });
    }
    for (const job of await (await getIssueQueue()).getJobs(PENDING_INTENT_JOB_STATES)) {
        const target = INTENT_JOB_NAMES.includes(job.name) ? jobIntentTarget(job) : null;
        if (!target || !sameRepository(target, repository)) continue;
        const row = await db('tasks').select('task_id').where({ job_id: String(job.id) }).first();
        const taskId = row?.task_id && candidates.has(row.task_id) ? row.task_id : intentJobTaskId(job as unknown as { id?: string; data: Record<string, unknown> });
        candidates.delete(taskId);
        candidates.set(String(job.id), { taskId, target });
    }
    return candidates;
}

/** Work still pending after the stops: nonterminal task states and unstarted jobs. */
async function remainingWork(repository: string): Promise<number> {
    let remaining = 0;
    for await (const task of nonTerminalTasks({ strict: true })) {
        const target = taskIntentTarget(task.issueRef, task.issueRef.type);
        if (target && sameRepository(target, repository)) remaining += 1;
    }
    const unstarted = PENDING_INTENT_JOB_STATES.filter(state => state !== 'active');
    for (const job of await (await getIssueQueue()).getJobs(unstarted)) {
        const target = INTENT_JOB_NAMES.includes(job.name) ? jobIntentTarget(job) : null;
        if (target && sameRepository(target, repository)) remaining += 1;
    }
    return remaining;
}

/**
 * Cancel every nonterminal task intent of `repository` without GitHub, then
 * verify none remains. Retained withdrawal cleanups are kept: they only keep an
 * issue out of discovery, which stays safe until access returns and ordinary
 * polling settles them. Throws when any cancellation is unrecorded or work
 * remains, so the caller cannot mistake it for convergence.
 */
export async function invalidateRepositoryIntents(redis: Redis, repository: string): Promise<{ cancelled: number; retainedCleanups: number }> {
    const candidates = await collectCandidates(repository);
    const results = await Promise.allSettled([...candidates].map(([id, candidate]) => stopTaskExecution(id, {
        redisClient: redisAdapter(redis), taskId: candidate.taskId, requestedBy: 'system',
        reason: formatTaskTerminalReason(REPOSITORY_UNAVAILABLE_REASON), cancellationReason: REPOSITORY_UNAVAILABLE_REASON,
        ensureCancelled: true,
    })));
    const prs = new Set([...candidates.values()].filter(candidate => candidate.target.kind === 'pr').map(candidate => candidate.target.number));
    for (const pr of prs) {
        const [owner, name] = repository.split('/');
        await clearUltrafixLoopState(owner, name, pr);
    }
    const failures = results.filter(result => result.status === 'rejected'
        || (!result.value.cancellationRecorded && !result.value.notRunning));
    if (failures.length > 0) throw new Error(`Could not record ${failures.length} repository intent cancellation(s) for ${repository}`);
    const remaining = await remainingWork(repository);
    if (remaining > 0) throw new Error(`${remaining} task intent(s) for ${repository} are still pending after invalidation`);
    const retainedCleanups = retainedCleanupTargets(await redis.smembers(WITHDRAWAL_CLEANUP_KEY))
        .filter(target => sameRepository(target, repository)).length;
    const cancelled = results.filter(result => result.status === 'fulfilled' && result.value.cancellationRecorded).length;
    logger.info({ repository, cancelled, retainedCleanups }, 'Invalidated task intents for a repository no longer configured or accessible');
    return { cancelled, retainedCleanups };
}
