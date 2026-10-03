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
import { clearUltrafixLoopState, getUltrafixStateRedis } from '../webhook/checkRunHelpers.js';
import { WITHDRAWAL_CLEANUP_KEY, markerAppliedSinceTrigger, releaseWithdrawalCleanup, retainWithdrawalCleanup, triggerAppliedSinceClosure, type CleanupRedis, type RetainedCleanup } from './withdrawalCleanup.js';
export { releaseWithdrawalCleanup } from './withdrawalCleanup.js';
import { stopTaskExecution, type StopTaskRedisClient } from './taskCancellation.js';
import { staleTriggerMarkers } from '../daemon/triggerApplicationEvidence.js';

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

/** Returns false, without deleting, once `mayRemove` says the label's owner changed. */
async function removeIntentLabel(target: IntentTarget, label: string, mayRemove?: () => Promise<boolean>): Promise<boolean> {
    const client = await getAuthenticatedOctokit();
    return withRetry(async () => {
        // Checked on every attempt: retry backoff can outlive the withdrawal.
        if (mayRemove && !await mayRemove()) return false;
        try {
            await client.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                owner: target.repoOwner, repo: target.repoName, issue_number: target.number, name: label,
            });
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
        }
        return true;
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
        // A requeued/rescheduled retry is recorded as cancelled but is still pending work,
        // and a failed attempt's queued retry resumes it. Only completion or a genuine
        // withdrawal ends a job's claim on the processing label.
        if (!state || !['completed', 'cancelled'].includes(state.state) || isBookkeepingCancellation(state)) return true;
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
    await removeIntentLabel(target, `${target.triggeringLabel}-processing`, async () => !await hasProcessingSibling(target, taskId));
}

/** Completed attempts for this issue/trigger whose PR still stands on its own. */
async function hasSiblingPullRequest(target: IntentTarget, trigger: string): Promise<boolean> {
    const rows: Array<{ initial_job_data: unknown; metadata: unknown }> = await db('tasks')
        .join('task_history', 'tasks.task_id', 'task_history.task_id')
        .whereRaw('LOWER(tasks.repository) = ?', [`${target.repoOwner}/${target.repoName}`.toLowerCase()])
        .where({ 'tasks.issue_number': target.number, 'tasks.task_type': 'issue', 'task_history.state': 'completed' })
        .select('tasks.initial_job_data', 'task_history.metadata');
    const parse = (value: unknown): Record<string, unknown> => {
        if (typeof value !== 'string') return (value ?? {}) as Record<string, unknown>;
        try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
    };
    return rows.some(row => {
        const label = parse(row.initial_job_data).triggeringLabel;
        const metadata = parse(row.metadata) as { pr?: { number?: number } | null; prResult?: { prNumber?: number; prCreated?: boolean } };
        return (label === undefined || label === trigger)
            && Boolean(metadata.pr?.number || metadata.prResult?.prNumber || metadata.prResult?.prCreated === true);
    });
}

function hasProcessingTrigger(current: CurrentTaskIntent, triggers: string[]): boolean {
    return (current.labels ?? []).some(label => triggers.includes(typeof label === 'string' ? label : label.name ?? ''));
}

/** Returns false when renewed intent now owns the issue's status labels. */
async function publishCancelledMarker(target: IntentTarget, triggers: string[], reason: IntentCancellationReason, revokingDone: string[]): Promise<boolean> {
    const octokit = await getAuthenticatedOctokit();
    return withRetry(async () => {
        // Check immediately before every publish attempt, including after retry
        // backoff. A reopen/restored trigger or sibling completion revokes it.
        const current = await readCurrentTaskIntent(target);
        if (withdrawnIntentReason(target, current, triggers) !== reason) return false;
        // Another trigger's new request or a sibling completion skips only the marker.
        if (reason === 'cancelled_label_removed' && hasProcessingTrigger(current, triggers)) return true;
        const labels = (current.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
        if (revokingDone.some(label => labels.includes(label))) return true;
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner: target.repoOwner, repo: target.repoName, issue_number: target.number,
            labels: [`${target.triggeringLabel ?? triggers[0] ?? 'AI'}-cancelled`],
        });
        return true;
    }, retryConfigs.githubApi, 'add_cancelled_label');
}

/** Returns true while the obligation's issue must stay out of discovery. */
async function settleWithdrawalCleanup(cleanup: RetainedCleanup, target: IntentTarget): Promise<boolean> {
    const triggers = await loadPrimaryProcessingLabels();
    const current = await readCurrentTaskIntent(target);
    if (withdrawnIntentReason(target, current, triggers) === 'cancelled_issue_closed') {
        // Still closed: retry the original cleanup.
        if (await updateWithdrawnIssueLabels(target, triggers, 'cancelled_issue_closed')) await releaseWithdrawalCleanup(cleanup);
        return true;
    }
    const labels = (current.labels ?? []).map(label => typeof label === 'string' ? label : label.name ?? '');
    const present = triggers.filter(trigger => labels.includes(trigger));
    // Without a trigger, only applying one renews intent. Restoration never
    // clears `-done`, so a completion marker keeps discovery idle on its own.
    if (!present.length || triggers.some(trigger => labels.includes(`${trigger}-done`))) {
        await releaseWithdrawalCleanup(cleanup);
        return true;
    }
    if (await triggerAppliedSinceClosure(target, present)) {
        await releaseWithdrawalCleanup(cleanup);
        return false;
    }
    // `-processing`/`-cancelled` exclude only when applied after the trigger's
    // latest application; an earlier one (e.g. a running sibling's marker that
    // a pre-closure reapplication supersedes) lets restoration readmit the issue.
    const markers = [...new Set(present.flatMap(trigger => staleTriggerMarkers(trigger, triggers)))].filter(label => labels.includes(label));
    if (markers.length && await markerAppliedSinceTrigger(target, present, markers)) {
        await releaseWithdrawalCleanup(cleanup);
        return true;
    }
    // Reopened without reapplying the trigger: publish the exclusion the
    // cancellation could not. Re-adding an applied label records no timeline
    // event, so a stale marker is removed first; the retained obligation keeps
    // discovery idle meanwhile. A reapplication racing these requests is an
    // unavoidable API race; it fails closed and needs another reapplication.
    const marker = `${target.triggeringLabel ?? present[0]}-cancelled`;
    if (labels.includes(marker) && !await removeIntentLabel(target, marker)) return true;
    const octokit = await getAuthenticatedOctokit();
    await withRetry(() => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner: target.repoOwner, repo: target.repoName, issue_number: target.number, labels: [marker],
    }), retryConfigs.githubApi, 'add_cancelled_label');
    await releaseWithdrawalCleanup(cleanup);
    return true;
}

/**
 * Retries retained closure exclusions for matching issues. Returns true when a
 * matching issue must stay idle. Without `onError`, failures propagate so
 * admission fails closed.
 */
export async function settleWithdrawalCleanups(redis: CleanupRedis, matches: (target: IntentTarget) => boolean,
    onError?: (target: IntentTarget, error: unknown) => void): Promise<boolean> {
    let idle = false;
    for (const member of await redis.smembers(WITHDRAWAL_CLEANUP_KEY)) {
        let target: IntentTarget;
        try {
            const data = JSON.parse(member) as Record<string, unknown>;
            const parsed = taskIntentTarget(data, 'issue');
            if (!parsed) continue;
            target = parsed;
        } catch {
            continue;
        }
        if (!matches(target)) continue;
        try {
            idle = await settleWithdrawalCleanup({ redis, member }, target) || idle;
        } catch (error) {
            if (!onError) throw error;
            onError(target, error);
        }
    }
    return idle;
}

/** Returns true once a withdrawal's exclusion stands, even if later status-label deletion stops early. */
export async function updateWithdrawnIssueLabels(target: IntentTarget, triggers: string[], reason?: TaskTerminalReason, taskId?: string): Promise<boolean> {
    if (target.kind !== 'issue') return false;
    if (reason === 'cancelled_by_user') {
        await clearUserStoppedProcessingLabel(target, taskId);
        return false;
    }
    // Stopping one attempt does not withdraw the issue's intent or its siblings' status.
    if (reason !== 'cancelled_issue_closed' && reason !== 'cancelled_label_removed') return false;
    // Stops may await Redis, the queue and containers. Refresh label authority
    // before cleanup so another trigger's live work keeps its status labels.
    const current = await readCurrentTaskIntent(target);
    const currentLabels = (current.labels ?? []).map(label => typeof label === 'string' ? label : label.name ?? '');
    if (withdrawnIntentReason(target, current, triggers) !== reason) return false;
    const labelsToClear = reason === 'cancelled_label_removed'
        ? (target.triggeringLabel ? [target.triggeringLabel] : triggers)
        : [...triggers, ...(target.triggeringLabel ? [target.triggeringLabel] : [])];
    // Discovery excludes every *-cancelled label, even for another trigger.
    const markCancelled = reason === 'cancelled_issue_closed' || !hasProcessingTrigger(current, triggers);
    // Stale completion markers are decided now, from the same refreshed read.
    // A sibling's opened PR stays independent, and so does its completion marker.
    const staleDone: string[] = [];
    for (const trigger of reason === 'cancelled_issue_closed' ? [] : new Set(labelsToClear)) {
        if (currentLabels.includes(`${trigger}-done`) && !await hasSiblingPullRequest(target, trigger)) staleDone.push(`${trigger}-done`);
    }
    const revokingDone = labelsToClear.map(trigger => `${trigger}-done`).filter(label => !staleDone.includes(label));
    // Publish before deleting: `-processing` keeps the issue out of discovery
    // until the marker exists, so a failed publish cannot readmit it on reopen.
    if (markCancelled && !await publishCancelledMarker(target, triggers, reason, revokingDone)) return false;
    // Renewed intent owns these labels; stop before any later deletion or retry.
    // The label scope was chosen for `reason`: a different withdrawal (e.g. a
    // reopen that swaps triggers after closure) may leave another trigger live.
    // A reopen landing between this read and the DELETE is an unavoidable API race.
    const stillWithdrawn = async () => withdrawnIntentReason(target, await readCurrentTaskIntent(target), triggers) === reason;
    const labels = [...new Set(labelsToClear)].flatMap(trigger => [`${trigger}-processing`, `${trigger}-waiting`, ...staleDone.filter(label => label === `${trigger}-done`)]);
    for (const label of labels) {
        if (!await removeIntentLabel(target, label, stillWithdrawn)) return true;
    }
    return true;
}

/** Retains a closure obligation in the Redis instance shared by webhooks, polling and queue pickup. */
export function retainClosureCleanup(target: IntentTarget, reason: string | undefined): Promise<RetainedCleanup | undefined> {
    return retainWithdrawalCleanup(getUltrafixStateRedis(), target, reason ?? '');
}

/**
 * Publishes a withdrawal's exclusion while a closure obligation keeps the issue
 * out of discovery; the obligation is released only once the exclusion stands.
 * Pass `cleanup` when it was retained before recording the cancellation.
 */
export async function excludeWithdrawnIssue(target: IntentTarget, reason: TaskTerminalReason | undefined, taskId?: string,
    cleanup?: RetainedCleanup): Promise<boolean> {
    const retained = cleanup ?? await retainClosureCleanup(target, reason);
    const excluded = await updateWithdrawnIssueLabels(target, await loadPrimaryProcessingLabels(), reason, taskId);
    if (excluded) await releaseWithdrawalCleanup(retained);
    return excluded;
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
    if (candidates.size === 0) return;
    // Read after the awaited scans. Event payloads and earlier polling reads
    // cannot authorize cancellation of a newly restored request.
    const triggers = await loadPrimaryProcessingLabels();
    const current = await readCurrentTaskIntent(target);
    if (withdrawnIntentReason(target, current, triggers) !== reason) return;
    // Retained before any stop, so a crash or failed publish leaves it for retry.
    const cleanup = await retainWithdrawalCleanup(redis, target, reason);
    let stopped = false;
    // Work withdrawn (a removed queue job or abort signal) whose cancellation
    // could not be recorded: discovery has nothing else to exclude it by.
    let unrecorded = false;
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
        unrecorded ||= !result.cancellationRecorded && (result.removedQueuedJobs > 0 || !!result.abortSignalled);
        return result;
    }));
    if (target.kind === 'pr') await clearUltrafixLoopState(target.repoOwner, target.repoName, target.number);
    // A failed publish throws and a reopen returns false; both keep the obligation.
    const excluded = (stopped || unrecorded) && await updateWithdrawnIssueLabels(target, triggers, reason);
    // A rejected stop may have removed its job before failing, so it keeps the obligation too.
    const unresolved = unrecorded || results.some(result => result.status === 'rejected');
    if (excluded || !stopped && !unresolved) await releaseWithdrawalCleanup(cleanup);
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
    // Cancelled requests leave the scans above, so failed exclusions are retried here.
    await settleWithdrawalCleanups(redis, target => repositories.some(repo => repo.toLowerCase() === `${target.repoOwner}/${target.repoName}`.toLowerCase()),
        (target, error) => logger.warn({ target, error }, 'Failed to publish retained cancellation exclusion; will retry next poll'));
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
        // A retry of a late worker cancellation whose cleanup failed: the
        // request is no longer scanned, so its obligation must outlive this attempt.
        await excludeWithdrawnIssue(target, existing.terminalReason, taskId);
        return existing.terminalReason ?? 'cancelled_by_user';
    }
    const reason = await checkCurrentTaskIntent(target);
    if (!reason || reason === 'cancelled_issue_closed' && await isIssueClosureProtected(target, await manager.getTaskState(taskId))) return null;
    await manager.createTaskStateIfAbsent(taskId, taskIntentIssueRef(data, target), typeof data.correlationId === 'string' ? data.correlationId : null, job.id ?? null);
    // Queue pickup shares the webhook/polling Redis instance.
    const cleanup = await retainClosureCleanup(target, reason);
    // This job is the failed attempt's live retry, so its withdrawal is recorded.
    const cancelled = await manager.markTaskCancelled(taskId, 'system', { reason: formatTaskTerminalReason(reason), terminalReason: reason, withdrawnQueuedRetry: true });
    if (cancelled && cancelled.state !== 'cancelled') {
        await releaseWithdrawalCleanup(cleanup);
        // If the state guard keeps the failure, the retry must still be
        // rejected. Only actual PR evidence exempts it from issue closure.
        if (cancelled.state === 'failed'
            && (reason !== 'cancelled_issue_closed' || !await isIssueClosureProtected(target, cancelled))) return reason;
        return null;
    }
    if (target.kind === 'pr') await clearUltrafixLoopState(target.repoOwner, target.repoName, target.number);
    await excludeWithdrawnIssue(target, reason, undefined, cleanup);
    return reason;
}
