import type { Redis } from 'ioredis';
import { buildIssueTaskId, formatTaskTerminalReason } from '@propr/shared';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import { getIssueQueue } from '../queue/taskQueue.js';
import { getStateManager } from '../utils/workerStateManager.js';
import { isBookkeepingCancellation, type IssueRef, type TaskStateData, type TaskTerminalReason } from '../utils/workerStateManager.types.js';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
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

export function taskIntentTarget(data: Record<string, unknown>, type = typeof data.type === 'string' ? data.type : undefined): IntentTarget | null {
    // Goals, imports and system maintenance are not issue implementations.
    if (data.goalId || data.taskDescription || !type || !['issue', 'pr-comment', 'review', 'merge_conflict'].includes(type)) return null;
    const repository = typeof data.repository === 'string' ? data.repository.split('/') : [];
    const repoOwner = typeof data.repoOwner === 'string' ? data.repoOwner : repository[0];
    const repoName = typeof data.repoName === 'string' ? data.repoName : repository[1];
    const pr = data.pullRequestNumber ?? data.prNumber;
    const kind = pr !== undefined || ['pr-comment', 'review', 'merge_conflict'].includes(type) ? 'pr' : 'issue';
    const number = pr ?? data.number ?? data.issueNumber;
    if (!repoOwner || !repoName || typeof number !== 'number' || number <= 0) return null;
    return { repoOwner, repoName, number, kind, ...(typeof data.triggeringLabel === 'string' ? { triggeringLabel: data.triggeringLabel } : {}) };
}

/** Persist only the small reference needed for intent, display and task identity. */
export function taskIntentIssueRef(data: object, target: IntentTarget): IssueRef {
    const fields = data as Record<string, unknown>;
    return {
        number: target.number, repoOwner: target.repoOwner, repoName: target.repoName,
        type: target.kind === 'pr' ? 'pr-comment' : 'issue',
        ...(target.kind === 'pr' ? { pullRequestNumber: target.number } : {}),
        ...Object.fromEntries(['triggeringLabel', 'modelName', 'agentAlias', 'correlationId'].flatMap(key =>
            typeof fields[key] === 'string' ? [[key, fields[key]]] : [])),
    };
}

async function readCurrentTaskIntent(target: IntentTarget): Promise<CurrentTaskIntent> {
    const octokit = await getAuthenticatedOctokit();
    const response = await withRetry<{ data: CurrentTaskIntent }>(() => target.kind === 'pr'
        ? octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: target.repoOwner, repo: target.repoName, pull_number: target.number })
        : octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner: target.repoOwner, repo: target.repoName, issue_number: target.number }),
    retryConfigs.githubApi, 'read_task_intent');
    return response.data;
}

async function removeIntentLabel(target: IntentTarget, label: string, stoppedTaskId?: string): Promise<void> {
    const client = await getAuthenticatedOctokit();
    await withRetry(async () => {
        if (stoppedTaskId && await hasProcessingSibling(target, stoppedTaskId)) return;
        try {
            await client.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                owner: target.repoOwner, repo: target.repoName, issue_number: target.number, name: label,
            });
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
        }
    }, retryConfigs.githubApi, 'remove_intent_label');
}

/** Webhooks and polling can restore a trigger without reviving the old attempt. */
export async function restoreIssueTrigger(target: IntentTarget): Promise<string[] | null> {
    if (target.kind !== 'issue' || !target.triggeringLabel) return null;
    const triggeringLabel = target.triggeringLabel;
    const triggers = await loadPrimaryProcessingLabels();
    const stale = [`${triggeringLabel}-processing`, ...triggers.map(trigger => `${trigger}-cancelled`)];
    const client = await getAuthenticatedOctokit();
    const readRestorableIntent = async () => {
        if (await hasProcessingSibling(target)) return null;
        // Queue/state scans and retry backoff can outlive the triggering event.
        const current = await readCurrentTaskIntent(target);
        return withdrawnIntentReason(target, current, [triggeringLabel]) ? null : current;
    };
    for (const label of stale) {
        const restored = await withRetry(async () => {
            const current = await readRestorableIntent();
            if (!current) return false;
            if (!(current.labels ?? []).some(value => (typeof value === 'string' ? value : value.name) === label)) return true;
            try {
                await client.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                    owner: target.repoOwner, repo: target.repoName, issue_number: target.number, name: label,
                });
            } catch (error) {
                if ((error as { status?: number }).status !== 404) throw error;
            }
            return true;
        }, retryConfigs.githubApi, 'restore_issue_trigger');
        if (!restored) return null;
    }
    // Admission must use live labels, including status published during cleanup.
    const current = await readRestorableIntent();
    return current ? (current.labels ?? []).map(label => typeof label === 'string' ? label : label.name ?? '') : null;
}

/** A closed issue may be the successful result of this task's own PR. */
export async function isIssueClosureProtected(target: IntentTarget, task: TaskStateData | null): Promise<boolean> {
    if (task?.prResult?.prNumber || task?.prResult?.prCreated === true) return true;
    const branch = task?.worktreeInfo?.branchName;
    if (typeof branch !== 'string') return false;
    const octokit = await getAuthenticatedOctokit();
    const result = await withRetry(() => octokit.graphql<{
        repository: { issue: { state: string; timelineItems: { nodes: Array<{ closer?: { headRefName?: string; headRepository?: { nameWithOwner: string } } }> } } };
    }>(`query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) { issue(number: $number) {
            state timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes {
                ... on ClosedEvent { closer { ... on PullRequest { headRefName headRepository { nameWithOwner } } } }
            } }
        } }
    }`, { owner: target.repoOwner, repo: target.repoName, number: target.number }), retryConfigs.githubApi, 'read_issue_closing_pr');
    const issue = result.repository.issue;
    const closer = issue.timelineItems.nodes[0]?.closer;
    // Reopening during the additional read also revokes closure authority.
    return issue.state !== 'CLOSED' || (closer?.headRefName === branch
        && closer.headRepository?.nameWithOwner.toLowerCase() === `${target.repoOwner}/${target.repoName}`.toLowerCase());
}

// Queue names are authoritative even when legacy job payloads have no type.
function jobIntentTarget(job: { name: string; data: unknown }): IntentTarget | null {
    const type = { processGitHubIssue: 'issue', processPullRequestComment: 'pr-comment', processMergeConflict: 'merge_conflict' }[job.name];
    return type ? taskIntentTarget(job.data as Record<string, unknown>, type) : null;
}

function sameResource(a: IntentTarget, b: IntentTarget): boolean {
    return a.kind === b.kind && a.number === b.number
        && a.repoOwner.toLowerCase() === b.repoOwner.toLowerCase()
        && a.repoName.toLowerCase() === b.repoName.toLowerCase();
}

async function hasProcessingSibling(target: IntentTarget, taskId?: string): Promise<boolean> {
    const manager = getStateManager();
    const matches = (candidate: IntentTarget | null) => candidate && sameResource(target, candidate)
        && (!candidate.triggeringLabel || candidate.triggeringLabel === target.triggeringLabel);
    for (const job of await (await getIssueQueue()).getJobs(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'])) {
        if (!matches(jobIntentTarget(job))) continue;
        const id = intentJobTaskId(job as unknown as { id?: string; data: Record<string, unknown> });
        if (id === taskId) continue;
        const state = await manager.getTaskState(id);
        if (!state || !['completed', 'failed', 'cancelled'].includes(state.state)) return true;
    }
    // Scan after the awaited queue reads so newly started siblings are included.
    let cursor = '0';
    do {
        const page = await manager.scanNonTerminalTasks(cursor);
        if (page.tasks.some(task => task.taskId !== taskId && matches(taskIntentTarget(task.issueRef)))) return true;
        cursor = page.nextCursor;
    } while (cursor !== '0');
    return false;
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

async function clearUserStoppedProcessingLabel(target: IntentTarget, taskId?: string): Promise<void> {
    // User stops own only the processing label, and only after sibling work ends.
    if (!taskId || !target.triggeringLabel) return;
    await removeIntentLabel(target, `${target.triggeringLabel}-processing`, taskId);
}

function hasProcessingTrigger(current: CurrentTaskIntent, triggers: string[]): boolean {
    return (current.labels ?? []).some(label => triggers.includes(typeof label === 'string' ? label : label.name ?? ''));
}

export async function updateWithdrawnIssueLabels(target: IntentTarget, triggers: string[], reason?: TaskTerminalReason, taskId?: string): Promise<void> {
    if (target.kind !== 'issue') return;
    if (reason === 'cancelled_by_user') {
        await clearUserStoppedProcessingLabel(target, taskId);
        return;
    }
    // Stopping one attempt does not withdraw the issue's intent or its siblings' status.
    if (reason !== 'cancelled_issue_closed' && reason !== 'cancelled_label_removed') return;
    const octokit = await getAuthenticatedOctokit();
    let labelsToClear = [...triggers, ...(target.triggeringLabel ? [target.triggeringLabel] : [])];
    let markCancelled = true;
    if (reason === 'cancelled_label_removed' || reason === 'cancelled_issue_closed') {
        // Stops may await Redis, the queue and containers. Refresh label authority
        // before cleanup so another trigger's live work keeps its status labels.
        const current = await readCurrentTaskIntent(target);
        if (withdrawnIntentReason(target, current, triggers) !== reason) return;
        if (reason === 'cancelled_label_removed') labelsToClear = target.triggeringLabel ? [target.triggeringLabel] : triggers;
        // Discovery excludes every *-cancelled label, even for another trigger.
        markCancelled = reason === 'cancelled_issue_closed' || !hasProcessingTrigger(current, triggers);
    }
    for (const trigger of new Set(labelsToClear)) {
        await removeIntentLabel(target, `${trigger}-processing`);
        await removeIntentLabel(target, `${trigger}-waiting`);
        if (reason !== 'cancelled_issue_closed') await removeIntentLabel(target, `${trigger}-done`);
    }
    if (!markCancelled) return;
    await withRetry(async () => {
        // Check immediately before every publish attempt, including after retry
        // backoff. A reopen/restored trigger or sibling completion revokes it.
        const current = await readCurrentTaskIntent(target);
        if (withdrawnIntentReason(target, current, triggers) !== reason) return;
        if (reason === 'cancelled_label_removed' && hasProcessingTrigger(current, triggers)) return;
        if (reason === 'cancelled_issue_closed' && labelsToClear.some(trigger =>
            (current.labels ?? []).some(label => (typeof label === 'string' ? label : label.name) === `${trigger}-done`))) return;
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner: target.repoOwner, repo: target.repoName, issue_number: target.number,
            labels: [`${target.triggeringLabel ?? triggers[0] ?? 'AI'}-cancelled`],
        });
    }, retryConfigs.githubApi, 'add_cancelled_label');
}

export function intentJobTaskId(job: { id?: string; data: Record<string, unknown> }): string {
    const data = job.data;
    if (data.isChildJob && typeof data.agentAlias === 'string' && typeof data.modelName === 'string' && typeof data.correlationId === 'string') {
        return buildIssueTaskId({ repoOwner: String(data.repoOwner), repoName: String(data.repoName), issueNumber: Number(data.number), agentAlias: data.agentAlias, modelName: data.modelName, correlationId: data.correlationId });
    }
    // Dispatcher IDs are reused after removal; their cancellation belongs to
    // this request, just like the child task IDs above. They have no worker task.
    if (!data.isChildJob && taskIntentTarget(data, 'issue')?.kind === 'issue' && typeof data.correlationId === 'string') {
        return `${job.id}-intent-${data.correlationId}`;
    }
    return String(job.id);
}

/** Cancel only work on this resource; an issue's already-opened PR is independent. */
export async function cancelWithdrawnIntent(target: IntentTarget, reason: IntentCancellationReason, redis: Redis): Promise<void> {
    const manager = getStateManager();
    const queue = await getIssueQueue();
    const candidates = new Map<string, { taskId: string; target: IntentTarget }>();
    const matches = (candidate: IntentTarget | null): candidate is IntentTarget => !!candidate && sameResource(candidate, target);
    let cursor = '0';
    do {
        const page = await manager.scanNonTerminalTasks(cursor);
        for (const task of page.tasks) {
            const candidate = taskIntentTarget(task.issueRef);
            if (matches(candidate)) candidates.set(task.taskId, { taskId: task.taskId, target: candidate });
        }
        cursor = page.nextCursor;
    } while (cursor !== '0');
    for (const job of await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'])) {
        const candidate = jobIntentTarget(job);
        if (!matches(candidate)) continue;
        const row = await db('tasks').select('task_id').where({ job_id: String(job.id) }).first();
        const taskId = row?.task_id && candidates.has(row.task_id) ? row.task_id : intentJobTaskId(job as unknown as { id?: string; data: Record<string, unknown> });
        candidates.delete(taskId);
        candidates.set(String(job.id), { taskId, target: candidate });
    }
    // Read after the awaited scans. Event payloads and earlier polling reads
    // cannot authorize cancellation of a newly restored request.
    const triggers = await loadPrimaryProcessingLabels();
    const current = await readCurrentTaskIntent(target);
    if (withdrawnIntentReason(target, current, triggers) !== reason) return;
    let stopped = false;
    const results = await Promise.allSettled([...candidates].map(async ([id, candidate]) => {
        if (reason === 'cancelled_label_removed'
            && (candidate.target.triggeringLabel && candidate.target.triggeringLabel !== target.triggeringLabel
                || withdrawnIntentReason(candidate.target, current, triggers) !== reason)) return;
        if (reason === 'cancelled_issue_closed'
            && await isIssueClosureProtected(target, await manager.getTaskState(candidate.taskId))) return;
        const result = await stopTaskExecution(id, {
            redisClient: redisAdapter(redis), taskId: candidate.taskId, requestedBy: 'system', reason: formatTaskTerminalReason(reason),
            cancellationReason: reason, ensureCancelled: true,
        });
        stopped ||= !!result.cancellationRecorded;
        return result;
    }));
    if (target.kind === 'pr') await clearUltrafixLoopState(target.repoOwner, target.repoName, target.number);
    if (stopped) await updateWithdrawnIssueLabels(target, triggers, reason);
    const failures = results.filter(result => result.status === 'rejected' || result.value && !result.value.cancellationRecorded && !result.value.notRunning);
    if (failures.length) throw new Error(`Could not record ${failures.length} intent cancellation(s)`);
}

export async function checkCurrentTaskIntent(target: IntentTarget): Promise<IntentCancellationReason | null> {
    const triggers = await loadPrimaryProcessingLabels();
    return withdrawnIntentReason(target, await readCurrentTaskIntent(target), triggers);
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
        if (['processGitHubIssue', 'processPullRequestComment', 'processMergeConflict'].includes(job.name)) add(jobIntentTarget(job));
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
    const target = jobIntentTarget(job);
    if (!target) return null;
    const taskId = intentJobTaskId({ id: job.id, data });
    const manager = getStateManager();
    const existing = await manager.getTaskState(taskId);
    if (existing?.state === 'cancelled' && !isBookkeepingCancellation(existing)) {
        await updateWithdrawnIssueLabels(target, await loadPrimaryProcessingLabels(), existing.terminalReason, taskId);
        return existing.terminalReason ?? 'cancelled_by_user';
    }
    const reason = await checkCurrentTaskIntent(target);
    if (!reason || reason === 'cancelled_issue_closed' && await isIssueClosureProtected(target, await manager.getTaskState(taskId))) return null;
    await manager.createTaskStateIfAbsent(taskId, taskIntentIssueRef(data, target), typeof data.correlationId === 'string' ? data.correlationId : null, job.id ?? null);
    const cancelled = await manager.markTaskCancelled(taskId, 'system', { reason: formatTaskTerminalReason(reason), terminalReason: reason });
    if (cancelled && cancelled.state !== 'cancelled') {
        // A failed attempt remains terminal, but its queued retry must still be
        // rejected. Only actual PR evidence exempts it from issue closure.
        if (cancelled.state === 'failed'
            && (reason !== 'cancelled_issue_closed' || !await isIssueClosureProtected(target, cancelled))) return reason;
        return null;
    }
    if (target.kind === 'pr') await clearUltrafixLoopState(target.repoOwner, target.repoName, target.number);
    await updateWithdrawnIssueLabels(target, await loadPrimaryProcessingLabels(), reason);
    return reason;
}
