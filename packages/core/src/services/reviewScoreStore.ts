/**
 * Persistence for parsed review scores and pull request outcomes.
 *
 * Every `/review` and Ultrafix review cycle that yields a parsed score writes
 * one `review_scores` row. The implementer is resolved once, at write time,
 * from the task that opened the pull request, so analytics can join a score
 * with the model that wrote the code and with what that work cost.
 */

import type { Knex } from 'knex';

export const REVIEW_SCORE_SOURCES = ['review', 'ultrafix'] as const;
export type ReviewScoreSource = typeof REVIEW_SCORE_SOURCES[number];

/** Task types that act on an existing pull request rather than open one. */
export const PULL_REQUEST_TASK_TYPES = ['pr-comment', 'review', 'merge_conflict'] as const;

export interface ReviewScoreInput {
    repository: string;
    prNumber: number;
    /** The review task that produced the score. */
    taskId: string;
    reviewerAgent: string | null;
    reviewerModel: string | null;
    score: number;
    blockerCount: number;
    suggestionCount: number;
    source: ReviewScoreSource;
    /** Ultrafix cycle number; null for a plain `/review`. */
    cycleNumber: number | null;
    /** Ultrafix target score in effect; null for a plain `/review`. */
    goal: number | null;
    headSha: string | null;
    createdAt?: Date;
}

export interface ReviewScoreRow {
    id: number;
    repository_id: string;
    pr_number: number;
    task_id: string;
    implementation_task_id: string | null;
    implementer_agent: string | null;
    implementer_model: string | null;
    reviewer_agent: string | null;
    reviewer_model: string | null;
    score: number;
    blocker_count: number;
    suggestion_count: number;
    cycle_number: number | null;
    goal: number | null;
    source: ReviewScoreSource;
    head_sha: string | null;
    created_at: string;
}

export interface ImplementationTask {
    taskId: string;
    agent: string | null;
    model: string | null;
}

function parseJson(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value !== 'string') return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * The task that opened the pull request: the earliest task recorded with this
 * PR number that is not itself a PR follow-up. Its model is the one the
 * executions recorded (so it matches the overview's model keys), falling back
 * to the model the task was created with.
 */
export async function resolveImplementationTask(
    database: Knex, repository: string, prNumber: number,
): Promise<ImplementationTask | null> {
    const task = await database('tasks')
        .where({ repository, pr_number: prNumber })
        .where(query => query.whereNull('task_type').orWhereNotIn('task_type', [...PULL_REQUEST_TASK_TYPES]))
        .whereNot('task_id', 'like', 'pr-comment%')
        .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'task_id', order: 'asc' }])
        .select('task_id', 'model_name', 'initial_job_data')
        .first() as { task_id: string; model_name: string | null; initial_job_data: unknown } | undefined;
    if (!task) return null;
    const execution = await database('llm_executions')
        .where({ task_id: task.task_id })
        .whereNotNull('model_name')
        .orderBy('start_time', 'asc')
        .select('model_name')
        .first() as { model_name: string } | undefined;
    const jobData = parseJson(task.initial_job_data);
    return {
        taskId: task.task_id,
        agent: text(jobData.agentAlias) ?? text(jobData.agent),
        model: text(execution?.model_name) ?? text(task.model_name) ?? text(jobData.model),
    };
}

function assertScoreInput(input: ReviewScoreInput): void {
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 10) {
        throw new RangeError(`review score must be an integer from 1 to 10, got ${input.score}`);
    }
    if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
        throw new RangeError('review score prNumber must be a positive integer');
    }
    if (!REVIEW_SCORE_SOURCES.includes(input.source)) {
        throw new RangeError(`review score source must be one of: ${REVIEW_SCORE_SOURCES.join(', ')}`);
    }
}

/**
 * Write one row per parsed score. All rows of one call describe the same pull
 * request, so the implementation task is resolved once.
 */
export async function recordReviewScores(database: Knex, inputs: readonly ReviewScoreInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    inputs.forEach(assertScoreInput);
    const implementations = new Map<string, ImplementationTask | null>();
    const rows = [];
    for (const input of inputs) {
        const key = `${input.repository}#${input.prNumber}`;
        if (!implementations.has(key)) {
            implementations.set(key, await resolveImplementationTask(database, input.repository, input.prNumber));
        }
        const implementation = implementations.get(key) ?? null;
        rows.push({
            repository_id: input.repository,
            pr_number: input.prNumber,
            task_id: input.taskId,
            implementation_task_id: implementation?.taskId ?? null,
            implementer_agent: implementation?.agent ?? null,
            implementer_model: implementation?.model ?? null,
            reviewer_agent: input.reviewerAgent,
            reviewer_model: input.reviewerModel,
            score: input.score,
            blocker_count: input.blockerCount,
            suggestion_count: input.suggestionCount,
            cycle_number: input.cycleNumber,
            goal: input.goal,
            source: input.source,
            head_sha: input.headSha,
            // ISO text, so period bounds compare exactly as the other stats do.
            created_at: (input.createdAt ?? new Date()).toISOString(),
        });
    }
    await database('review_scores').insert(rows);
    return rows.length;
}

/** Score history of one pull request, oldest first. */
export async function loadPullRequestScoreHistory(
    database: Knex, repository: string, prNumber: number,
): Promise<ReviewScoreRow[]> {
    return await database('review_scores')
        .where({ repository_id: repository, pr_number: prNumber })
        .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
        .select('*') as ReviewScoreRow[];
}

export interface PullRequestOutcomeEvent {
    repository: string;
    prNumber: number;
    action: 'closed' | 'reopened';
    merged: boolean;
    mergedAt?: string | null;
    closedAt?: string | null;
}

const isoOrNow = (value: string | null | undefined): string => {
    const parsed = value ? new Date(value) : new Date();
    return (Number.isNaN(parsed.getTime()) ? new Date() : parsed).toISOString();
};

/**
 * Record a pull request's final outcome on its `notification_pull_request_state`
 * row. A reopened pull request is open again, so its outcome is cleared; a
 * merge is final and is never cleared.
 */
export async function recordPullRequestOutcome(database: Knex, event: PullRequestOutcomeEvent): Promise<void> {
    const identity = { repository: event.repository, pr_number: event.prNumber };
    if (event.action === 'reopened') {
        await database('notification_pull_request_state').where(identity).whereNull('merged_at')
            .update({ outcome: null, closed_at: null });
        return;
    }
    const closedAt = isoOrNow(event.closedAt ?? event.mergedAt);
    const values: Record<string, unknown> = {
        outcome: event.merged ? 'merged' : 'closed',
        closed_at: closedAt,
        ...(event.merged && { merged_at: isoOrNow(event.mergedAt ?? event.closedAt) }),
    };
    await database('notification_pull_request_state')
        .insert({ ...identity, merged_at: null, ...values })
        .onConflict(['repository', 'pr_number'])
        .merge(values);
}
