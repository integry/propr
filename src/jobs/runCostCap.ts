import type { Logger } from 'pino';
import {
    createNotificationEvent, db, findIssueSubmission, getActiveRunCostGuard, getAuthenticatedOctokit, getStateManager, loadDefaultMaxCostUsd, loadMonitoredReposRaw, logger,
    readIssueCostCapOverride, readRecordedTaskSpend, resolveRunCostCap, RunCostGuard, runWithRunCostGuard, storeResolvedRunCostCap,
} from '@propr/core';
import { formatUsd, RUN_COST_CAP_SOURCE_LABELS } from '@propr/shared';
import type { CommentJobData, IssueJobData, RecordedSpend, SubmissionPayload, RunCostCap, RunCostSnapshot, RunUsagePricer } from '@propr/core';
import type { Job } from 'bullmq';
import type { Knex } from 'knex';
import { recordLineageCostCap } from '../taskReplacement/store.js';

export type CommentOctokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

/** The run a spend cap applies to, and where its stop is reported. */
export interface RunCostCapTarget {
    taskId: string;
    repoOwner: string;
    repoName: string;
    /** The issue or pull request the run reports to. */
    number: number;
    kind: 'issue' | 'pull_request';
    modelName?: string;
    /** Per-task `maxCostUsd`. */
    override?: unknown;
    /** `limits.max_cost_usd` when the repository workflow is already known. */
    workflowCap?: unknown;
    /** Earlier attempts (with their own task IDs) whose spend this run continues. */
    budgetTaskIds?: string[];
    getOctokit?: () => Promise<CommentOctokit | null | undefined> | CommentOctokit | null | undefined;
    logger?: Logger;
}

export interface RunCostCapDeps {
    loadInstanceDefault(): Promise<unknown>;
    readRecordedSpend(taskIds: string[]): Promise<number | RecordedSpend>;
    storeCap(taskId: string, cap: RunCostCap | null, budgetTaskIds: string[]): Promise<void>;
    recordExceeded(target: RunCostCapTarget, snapshot: RunCostSnapshot): Promise<void>;
    priceUsage?: RunUsagePricer;
    checkIntervalMs?: number;
}

export const defaultRunCostCapDeps: RunCostCapDeps = {
    loadInstanceDefault: () => loadDefaultMaxCostUsd(),
    readRecordedSpend: taskIds => readRecordedTaskSpend(taskIds),
    storeCap: (taskId, cap, budgetTaskIds) => storeResolvedRunCostCap(taskId, cap ? { ...cap, ...(budgetTaskIds.length ? { budgetTaskIds } : {}) } : null),
    recordExceeded: (target, snapshot) => recordRunCostCapExceeded(target, snapshot),
};

/**
 * Runs one implementation, follow-up, /fix, ultrafix cycle or review with its
 * spend cap enforced on every agent container it starts. The cap comes from
 * the task override, then `.propr/workflow.yml`, then the instance default;
 * spend recorded by earlier attempts of the same task counts toward it.
 * A default that cannot be read fails the attempt (before any agent starts)
 * unless the task override already sets the cap.
 */
export async function withRunCostCap<T>(target: RunCostCapTarget, operation: (guard: RunCostGuard) => Promise<T>, deps: RunCostCapDeps = defaultRunCostCapDeps): Promise<T> {
    const log = target.logger ?? logger;
    let instanceDefault: unknown;
    try { instanceDefault = await deps.loadInstanceDefault(); } catch (error) {
        // An unreadable default may be a configured cap; only a task override,
        // which outranks it, lets the run start without it.
        if (resolveRunCostCap({ override: target.override })?.source !== 'override') throw error;
        log.warn({ taskId: target.taskId, error: (error as Error).message }, 'Could not load the default spend cap; the task override applies');
    }
    const budgetTaskIds = [...new Set((target.budgetTaskIds ?? []).filter(id => id && id !== target.taskId))];
    const guard = new RunCostGuard({
        taskId: target.taskId,
        inputs: { override: target.override, workflow: target.workflowCap, instanceDefault },
        defaultModel: target.modelName,
        readRecordedSpend: () => deps.readRecordedSpend([target.taskId, ...budgetTaskIds]),
        onCapResolved: cap => deps.storeCap(target.taskId, cap, budgetTaskIds),
        onExceeded: snapshot => deps.recordExceeded({ ...target, budgetTaskIds }, snapshot),
        ...(deps.priceUsage ? { priceUsage: deps.priceUsage } : {}),
        ...(deps.checkIntervalMs ? { checkIntervalMs: deps.checkIntervalMs } : {}),
    });
    await guard.start();
    try {
        return await runWithRunCostGuard(guard, () => operation(guard));
    } finally {
        guard.close();
    }
}

/** Issue runs also record their effective cap on the task, so its replacements are budgeted from it. */
export function issueRunCostCapDeps(database: Knex = db, base: RunCostCapDeps = defaultRunCostCapDeps): RunCostCapDeps {
    return {
        ...base,
        async storeCap(taskId, cap, budgetTaskIds) {
            try {
                await recordLineageCostCap(database, taskId, cap?.capUsd ?? null);
            } finally {
                await base.storeCap(taskId, cap, budgetTaskIds);
            }
        },
    };
}

/** Applies `limits.max_cost_usd` from the run's repository workflow once it is known, and returns the workflow. */
export async function applyWorkflowCostCap<T extends { config?: { limits?: { max_cost_usd?: unknown } } } | null | undefined>(workflow: T): Promise<T> {
    await getActiveRunCostGuard()?.setWorkflowCap(workflow?.config?.limits?.max_cost_usd);
    return workflow;
}

/**
 * A follow-up, /fix, ultrafix cycle or review: its task ID is its queue job
 * ID, and its workflow cap is applied once the base policy is read.
 */
export function pullRequestRunCostCapTarget(job: Pick<Job<CommentJobData>, 'id' | 'data'>): RunCostCapTarget {
    const { data } = job;
    return {
        taskId: String(job.id), repoOwner: data.repoOwner, repoName: data.repoName,
        number: data.pullRequestNumber, kind: 'pull_request',
        ...(data.llm ? { modelName: data.llm } : {}),
        override: data.maxCostUsd, budgetTaskIds: data.costBudgetTaskIds,
        getOctokit: async () => await getAuthenticatedOctokit() as unknown as CommentOctokit,
    };
}

/**
 * An issue implementation: its spend cap inputs are the task override (job,
 * submission or `propr issue implement --max-cost`) and the workflow file; a
 * replacement attempt also counts what its earlier attempts spent. A
 * failed override lookup is thrown: the override may be the cap, so the run
 * must not start without it.
 */
export async function issueRunCostCapTarget(
    data: IssueJobData,
    context: { taskId: string; modelName?: string; correlatedLogger: Logger; repositoryWorkflow?: { config: { limits?: { max_cost_usd?: unknown } } } },
    getOctokit: RunCostCapTarget['getOctokit'],
    lookups: { findSubmission: typeof findIssueSubmission; readOverride: typeof readIssueCostCapOverride } = { findSubmission: findIssueSubmission, readOverride: readIssueCostCapOverride },
): Promise<RunCostCapTarget> {
    const { taskId, modelName, correlatedLogger } = context;
    let override: unknown = data.maxCostUsd;
    if (override === undefined) {
        const submission = await lookups.findSubmission(data);
        try {
            override = submission ? (JSON.parse(submission.payload) as SubmissionPayload).maxCostUsd : undefined;
        } catch (error) {
            correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Ignoring the malformed submission spend cap override');
        }
    }
    override ??= await lookups.readOverride(`${data.repoOwner}/${data.repoName}`, data.number);
    return {
        taskId, repoOwner: data.repoOwner, repoName: data.repoName, number: data.number, kind: 'issue',
        modelName, override, workflowCap: context.repositoryWorkflow?.config.limits?.max_cost_usd,
        ...(data.costBudgetTaskIds?.length ? { budgetTaskIds: data.costBudgetTaskIds } : {}),
        getOctokit, logger: correlatedLogger,
    };
}

function describeTarget(target: Pick<RunCostCapTarget, 'kind' | 'number'>): string {
    return target.kind === 'pull_request' ? `PR #${target.number}` : `issue #${target.number}`;
}

/**
 * The `budget.exceeded` timeline event: what the cap was, what was spent, and
 * where the cap came from. It also keeps the earlier attempts whose spend the
 * run continued, so task history can still add them up after the resolved cap
 * expires from Redis.
 */
export function budgetExceededEvent(snapshot: RunCostSnapshot, budgetTaskIds: readonly string[] = []) {
    const source = RUN_COST_CAP_SOURCE_LABELS[snapshot.cap.source];
    return {
        reason: `Spend cap reached: estimated ${formatUsd(snapshot.spentUsd)} of ${formatUsd(snapshot.cap.capUsd)} (cap from ${source}); stopping the agent`,
        metadata: {
            event: 'budget.exceeded',
            budget: {
                capUsd: snapshot.cap.capUsd,
                spentUsd: Number(snapshot.spentUsd.toFixed(6)),
                priorSpentUsd: Number(snapshot.priorSpentUsd.toFixed(6)),
                percent: Math.round(snapshot.percent),
                source: snapshot.cap.source,
                ...(budgetTaskIds.length ? { budgetTaskIds: [...budgetTaskIds] } : {}),
            },
        },
    };
}

/** Records the `budget.exceeded` event on the run's task timeline, if the task exists. */
export async function writeTimelineEvent(target: Pick<RunCostCapTarget, 'taskId' | 'budgetTaskIds'>, snapshot: RunCostSnapshot): Promise<void> {
    const task = await db('tasks').where({ task_id: target.taskId }).first('task_id');
    if (!task) return;
    const current = await getStateManager().getTaskState(target.taskId);
    const event = budgetExceededEvent(snapshot, target.budgetTaskIds);
    await db('task_history').insert({
        task_id: target.taskId,
        // The run is still executing; the event must not read as a lifecycle change.
        state: current?.state ?? 'claude_execution',
        timestamp: new Date().toISOString(),
        reason: event.reason,
        metadata: JSON.stringify(event.metadata),
    });
}

async function repositoryNotificationsEnabled(repository: string): Promise<boolean> {
    const entries = (await loadMonitoredReposRaw()).filter(entry => entry.name.toLowerCase() === repository.toLowerCase());
    // Mirrors the Inbox projection: disabled only when every configured entry opts out.
    return entries.length === 0 || entries.some(entry => (entry as { notificationsEnabled?: boolean }).notificationsEnabled !== false);
}

async function notifySpendCap(target: RunCostCapTarget, snapshot: RunCostSnapshot): Promise<void> {
    const repository = `${target.repoOwner}/${target.repoName}`;
    if (!await repositoryNotificationsEnabled(repository)) return;
    const members = await db('instance_members').distinct('github_user_id') as Array<{ github_user_id?: unknown }>;
    const recipients = members.flatMap(row => typeof row.github_user_id === 'string' ? [{ userId: row.github_user_id, pushEnabled: true }] : []);
    if (recipients.length === 0) return;
    await createNotificationEvent({
        deduplicationKey: `budget-exceeded:${target.taskId}`,
        kind: 'task',
        severity: 'warning',
        target: {
            type: 'task', repository, taskId: target.taskId,
            ...(target.kind === 'pull_request' ? { prNumber: target.number } : { issueNumber: target.number }),
        },
        title: `Spend cap reached for ${describeTarget(target)}`,
        body: `Stopped at an estimated ${formatUsd(snapshot.spentUsd)} of its ${formatUsd(snapshot.cap.capUsd)} cap (${RUN_COST_CAP_SOURCE_LABELS[snapshot.cap.source]}). Partial work is published.`,
        metadata: { event: 'budget.exceeded', capUsd: snapshot.cap.capUsd, spentUsd: Number(snapshot.spentUsd.toFixed(6)), source: snapshot.cap.source },
    }, recipients);
}

/** Tells the issue or pull request, in the style of the other failure notices, that its run was stopped at its spend cap. */
export async function postCostCapNotice(
    target: { repoOwner: string; repoName: string; number: number },
    octokit: CommentOctokit,
    snapshot: Pick<RunCostSnapshot, 'cap' | 'spentUsd'>,
    correlatedLogger: Pick<Logger, 'warn'>,
): Promise<void> {
    try {
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: target.repoOwner,
            repo: target.repoName,
            issue_number: target.number,
            body: `🛑 **Spend cap reached**\n\nThis run was stopped at an estimated ${formatUsd(snapshot.spentUsd)}, reaching its ${formatUsd(snapshot.cap.capUsd)} spend cap (from ${RUN_COST_CAP_SOURCE_LABELS[snapshot.cap.source]}). Any partial work is published as for a timed-out run.\n\nRaise the cap (\`maxCostUsd\`, \`limits.max_cost_usd\` in \`.propr/workflow.yml\` or the \`default_max_cost_usd\` setting) to continue.`
        });
    } catch (commentError) {
        correlatedLogger.warn({ error: (commentError as Error).message }, 'Failed to post spend cap notice');
    }
}

/** Records a spend-cap stop on the task timeline, in the Inbox and on GitHub; each step is best-effort. */
export async function recordRunCostCapExceeded(target: RunCostCapTarget, snapshot: RunCostSnapshot): Promise<void> {
    const log = target.logger ?? logger;
    const steps: Array<[string, () => Promise<void>]> = [
        ['timeline event', () => writeTimelineEvent(target, snapshot)],
        ['notification', () => notifySpendCap(target, snapshot)],
        ['GitHub comment', async () => {
            const octokit = await target.getOctokit?.();
            if (octokit) await postCostCapNotice({ repoOwner: target.repoOwner, repoName: target.repoName, number: target.number }, octokit, snapshot, log);
        }],
    ];
    for (const [name, step] of steps) {
        try { await step(); } catch (error) {
            log.warn({ taskId: target.taskId, error: (error as Error).message }, `Could not record spend cap ${name}`);
        }
    }
}
