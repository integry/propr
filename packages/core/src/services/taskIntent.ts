import type { Redis } from 'ioredis';
import { buildIssueTaskId, formatTaskTerminalReason } from '@propr/shared';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import { getIssueQueue } from '../queue/taskQueue.js';
import { getStateManager } from '../utils/workerStateManager.js';
import type { TaskTerminalReason } from '../utils/workerStateManager.types.js';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { safeAddLabel, safeRemoveLabel } from '../utils/github/labelOperations.js';
import { clearUltrafixLoopState } from '../webhook/checkRunHelpers.js';
import { stopTaskExecution, type StopTaskRedisClient } from './taskCancellation.js';

export type IntentCancellationReason = 'cancelled_issue_closed' | 'cancelled_label_removed' | 'cancelled_pr_closed';
export interface IntentTarget {
    repoOwner: string;
    repoName: string;
    number: number;
    kind: 'issue' | 'pr';
    triggeringLabel?: string;
}

export function taskIntentTarget(data: Record<string, unknown>, type?: string): IntentTarget | null {
    const repository = typeof data.repository === 'string' ? data.repository.split('/') : [];
    const repoOwner = typeof data.repoOwner === 'string' ? data.repoOwner : repository[0];
    const repoName = typeof data.repoName === 'string' ? data.repoName : repository[1];
    const pr = data.pullRequestNumber ?? data.prNumber;
    const kind = pr !== undefined || type === 'pr-comment' || type === 'review' || type === 'merge_conflict' ? 'pr' : 'issue';
    const number = pr ?? data.number ?? data.issueNumber;
    // Goals, imports and system maintenance are not issue implementations.
    if (data.goalId || data.taskDescription || (type && !['issue', 'pr-comment', 'review', 'merge_conflict'].includes(type))) return null;
    if (!repoOwner || !repoName || typeof number !== 'number' || number <= 0) return null;
    return { repoOwner, repoName, number, kind, ...(typeof data.triggeringLabel === 'string' ? { triggeringLabel: data.triggeringLabel } : {}) };
}

export interface CurrentTaskIntent { state?: string; merged?: boolean; labels?: Array<string | { name?: string }> }

export function withdrawnIntentReason(target: IntentTarget, current: CurrentTaskIntent, triggers: string[]): IntentCancellationReason | null {
    if (current.state === 'closed') return target.kind === 'pr' ? (current.merged ? null : 'cancelled_pr_closed') : 'cancelled_issue_closed';
    if (target.kind === 'pr') return null;
    const labels = (current.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
    const required = target.triggeringLabel ? [target.triggeringLabel] : triggers;
    return required.some(label => labels.includes(label)) ? null : 'cancelled_label_removed';
}

function redisAdapter(redis: Redis): StopTaskRedisClient {
    return {
        get: key => redis.get(key),
        set: (key, value, options) => options?.EX ? redis.set(key, value, 'EX', options.EX) : redis.set(key, value),
        rPush: (key, value) => redis.rpush(key, value),
        del: key => redis.del(key),
    };
}

export async function updateWithdrawnIssueLabels(target: IntentTarget, triggers: string[], reason?: TaskTerminalReason): Promise<void> {
    if (target.kind !== 'issue') return;
    // Stopping one attempt does not withdraw the issue's intent or its siblings' status.
    if (reason !== 'cancelled_issue_closed' && reason !== 'cancelled_label_removed') return;
    const octokit = await getAuthenticatedOctokit();
    let labelsToClear = [...triggers, ...(target.triggeringLabel ? [target.triggeringLabel] : [])];
    let markCancelled = true;
    if (reason === 'cancelled_label_removed') {
        // Stops may await Redis, the queue and containers. Refresh label authority
        // before cleanup so another trigger's live work keeps its status labels.
        const { data: current } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner: target.repoOwner, repo: target.repoName, issue_number: target.number,
        });
        if (withdrawnIntentReason(target, current, triggers) !== reason) return;
        labelsToClear = target.triggeringLabel ? [target.triggeringLabel] : triggers;
        // Discovery excludes every *-cancelled label, even for another trigger.
        markCancelled = !(current.labels ?? []).some(label => triggers.includes(typeof label === 'string' ? label : label.name ?? ''));
    }
    const options = { octokit, owner: target.repoOwner, repo: target.repoName, issueNumber: target.number, logger: logger.withCorrelation('intent-withdrawal') };
    for (const trigger of new Set(labelsToClear)) {
        await safeRemoveLabel(options, `${trigger}-processing`);
        await safeRemoveLabel(options, `${trigger}-waiting`);
        await safeRemoveLabel(options, `${trigger}-done`);
    }
    if (markCancelled && reason === 'cancelled_label_removed') {
        // The cleanup above awaits multiple GitHub calls. Recheck immediately
        // before publishing a marker that would exclude every trigger's work.
        const { data: current } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner: target.repoOwner, repo: target.repoName, issue_number: target.number,
        });
        markCancelled = withdrawnIntentReason(target, current, triggers) === reason
            && !(current.labels ?? []).some(label => triggers.includes(typeof label === 'string' ? label : label.name ?? ''));
    }
    if (markCancelled) await safeAddLabel(options, `${target.triggeringLabel ?? triggers[0] ?? 'AI'}-cancelled`);
}

export function intentJobTaskId(job: { id?: string; data: Record<string, unknown> }): string {
    const data = job.data;
    if (data.isChildJob && typeof data.agentAlias === 'string' && typeof data.modelName === 'string' && typeof data.correlationId === 'string') {
        return buildIssueTaskId({ repoOwner: String(data.repoOwner), repoName: String(data.repoName), issueNumber: Number(data.number), agentAlias: data.agentAlias, modelName: data.modelName, correlationId: data.correlationId });
    }
    // Dispatcher IDs are reused after removal; their cancellation belongs to
    // this request, just like the child task IDs above. They have no worker task.
    if (!data.isChildJob && taskIntentTarget(data)?.kind === 'issue' && typeof data.correlationId === 'string') {
        return `${job.id}-intent-${data.correlationId}`;
    }
    return String(job.id);
}

/** Cancel only work on this resource; an issue's already-opened PR is independent. */
export async function cancelWithdrawnIntent(target: IntentTarget, reason: IntentCancellationReason, redis: Redis, current?: CurrentTaskIntent): Promise<void> {
    const manager = getStateManager();
    const queue = await getIssueQueue();
    const matches = (candidate: IntentTarget | null) => candidate && candidate.kind === target.kind && candidate.number === target.number
        && candidate.repoOwner.toLowerCase() === target.repoOwner.toLowerCase() && candidate.repoName.toLowerCase() === target.repoName.toLowerCase();
    const triggers = current && reason === 'cancelled_label_removed' ? await loadPrimaryProcessingLabels() : [];
    const shouldStop = (candidate: IntentTarget | null) => {
        if (!matches(candidate) || !candidate) return false;
        if (reason !== 'cancelled_label_removed') return true;
        // Polling checks one trigger at a time. Webhooks also carry the labels
        // needed to decide legacy work whose trigger was not recorded.
        if (candidate.triggeringLabel !== target.triggeringLabel) {
            if (candidate.triggeringLabel || !current) return false;
        }
        return !current || withdrawnIntentReason(candidate, current, triggers) === reason;
    };
    const stops = new Map<string, string>();
    let cursor = '0';
    do {
        const page = await manager.scanNonTerminalTasks(cursor);
        for (const task of page.tasks) {
            if (shouldStop(taskIntentTarget(task.issueRef, task.issueRef.type))) stops.set(task.taskId, task.taskId);
        }
        cursor = page.nextCursor;
    } while (cursor !== '0');
    for (const job of await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'])) {
        if (!['processGitHubIssue', 'processPullRequestComment', 'processMergeConflict'].includes(job.name)) continue;
        if (!shouldStop(taskIntentTarget(job.data as unknown as Record<string, unknown>))) continue;
        const row = await db('tasks').select('task_id').where({ job_id: String(job.id) }).first();
        const taskId = row?.task_id && stops.has(row.task_id) ? row.task_id : intentJobTaskId(job as unknown as { id?: string; data: Record<string, unknown> });
        stops.delete(taskId);
        stops.set(String(job.id), taskId);
    }
    const results = await Promise.allSettled([...stops].map(([id, taskId]) => stopTaskExecution(id, {
        redisClient: redisAdapter(redis), taskId, requestedBy: 'system', reason: formatTaskTerminalReason(reason),
        cancellationReason: reason, ensureCancelled: true,
    })));
    if (target.kind === 'pr') await clearUltrafixLoopState(target.repoOwner, target.repoName, target.number);
    if (stops.size) await updateWithdrawnIssueLabels(target, await loadPrimaryProcessingLabels(), reason);
    const failures = results.filter(result => result.status === 'rejected' || !result.value.cancellationRecorded && !result.value.notRunning);
    if (failures.length) throw new Error(`Could not record ${failures.length} intent cancellation(s)`);
}

export async function checkCurrentTaskIntent(target: IntentTarget): Promise<IntentCancellationReason | null> {
    const octokit = await getAuthenticatedOctokit();
    const current = target.kind === 'pr'
        ? await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: target.repoOwner, repo: target.repoName, pull_number: target.number })
        : await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner: target.repoOwner, repo: target.repoName, issue_number: target.number });
    return withdrawnIntentReason(target, current.data, await loadPrimaryProcessingLabels());
}

/** Poll active and queued resources directly: closed/unlabeled issues disappear from discovery queries. */
export async function reconcileTaskIntents(redis: Redis, repositories: string[]): Promise<void> {
    const targets = new Map<string, IntentTarget>();
    const add = (target: IntentTarget | null) => {
        if (target && repositories.some(repo => repo.toLowerCase() === `${target.repoOwner}/${target.repoName}`.toLowerCase())) {
            targets.set(`${target.repoOwner}/${target.repoName}/${target.kind}/${target.number}/${target.triggeringLabel ?? ''}`, target);
        }
    };
    let cursor = '0';
    do {
        const page = await getStateManager().scanNonTerminalTasks(cursor);
        for (const task of page.tasks) add(taskIntentTarget(task.issueRef, task.issueRef.type));
        cursor = page.nextCursor;
    } while (cursor !== '0');
    for (const job of await (await getIssueQueue()).getJobs(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'])) {
        if (['processGitHubIssue', 'processPullRequestComment', 'processMergeConflict'].includes(job.name)) add(taskIntentTarget(job.data as unknown as Record<string, unknown>));
    }
    for (const target of targets.values()) {
        try {
            const reason = await checkCurrentTaskIntent(target);
            if (reason) await cancelWithdrawnIntent(target, reason, redis);
        } catch (error) {
            logger.warn({ target, error }, 'Failed to reconcile task intent; will retry next poll');
        }
    }
}

/** Runs before any dispatcher, review, worktree or agent side effects. API errors fail closed. */
export async function preventWithdrawnJob(job: { id?: string; name: string; data: unknown }): Promise<string | null> {
    if (!['processGitHubIssue', 'processPullRequestComment', 'processMergeConflict'].includes(job.name)) return null;
    const data = job.data as Record<string, unknown>;
    const target = taskIntentTarget(data);
    if (!target) return null;
    const taskId = intentJobTaskId({ id: job.id, data });
    const manager = getStateManager();
    const existing = await manager.getTaskState(taskId);
    if (existing?.state === 'cancelled') return existing.terminalReason ?? 'cancelled_by_user';
    const reason = await checkCurrentTaskIntent(target);
    if (!reason) return null;
    await manager.createTaskStateIfAbsent(taskId, {
        ...data, number: target.number, repoOwner: target.repoOwner, repoName: target.repoName,
        type: target.kind === 'pr' ? 'pr-comment' : 'issue',
    }, typeof data.correlationId === 'string' ? data.correlationId : null, job.id ?? null);
    await manager.markTaskCancelled(taskId, 'system', { reason: formatTaskTerminalReason(reason), terminalReason: reason });
    if (target.kind === 'pr') await clearUltrafixLoopState(target.repoOwner, target.repoName, target.number);
    await updateWithdrawnIssueLabels(target, await loadPrimaryProcessingLabels(), reason);
    return reason;
}
