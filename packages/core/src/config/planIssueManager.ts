import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { checkAndUpdateDraftStatus } from '../services/taskPlanningService.js';
import { resolvePlanIssueDefaultSelection } from './planIssueDefaults.js';

/**
 * Status enum for plan issues.
 * - PENDING: Issue created, not yet implementing
 * - PROCESSING: Initial AI processing in progress
 * - UNDER_REVIEW: PR created, awaiting review
 * - IN_REFINEMENT: Follow-up comments being processed
 * - REFINEMENT_PROCESSING: Processing follow-up comments
 * - MERGED: PR has been merged
 * - CLOSED: Issue/PR closed without merge
 */
export enum PlanIssueStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    UNDER_REVIEW = 'under_review',
    IN_REFINEMENT = 'in_refinement',
    REFINEMENT_PROCESSING = 'refinement_processing',
    MERGED = 'merged',
    CLOSED = 'closed'
}

/**
 * Represents a plan issue record in the database.
 */
export interface PlanIssue {
    id: number;
    draft_id: string;
    repository: string;
    issue_number: number;
    pr_number: number | null;
    status: PlanIssueStatus;
    agent_alias: string | null;
    model_name: string | null;
    followup_count: number;
    task_id: string | null;
    run_ultrafix: number | boolean | null;
    ultrafix_goal: number | null;
    ultrafix_max_cycles: number | null;
    created_at: string;
    updated_at: string;
}

/**
 * Input for creating a new plan issue.
 */
export interface CreatePlanIssueInput {
    draft_id: string;
    repository: string;
    issue_number: number;
    agent_alias?: string;
    model_name?: string;
    run_ultrafix?: boolean | null;
    ultrafix_goal?: number | null;
    ultrafix_max_cycles?: number | null;
}

/**
 * Input for updating a plan issue.
 */
export interface UpdatePlanIssueInput {
    pr_number?: number | null;
    status?: PlanIssueStatus;
    agent_alias?: string | null;
    model_name?: string | null;
    followup_count?: number;
    task_id?: string | null;
    run_ultrafix?: boolean | null;
    ultrafix_goal?: number | null;
    ultrafix_max_cycles?: number | null;
}

/**
 * Options for paginated plan issues query.
 */
export interface GetPlanIssuesOptions {
    page?: number;
    limit?: number;
    status?: PlanIssueStatus;
}

/**
 * Result from paginated plan issues query.
 */
export interface PaginatedPlanIssuesResult {
    issues: PlanIssue[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
}

/**
 * Creates a new plan issue record.
 */
export async function createPlanIssue(input: CreatePlanIssueInput): Promise<PlanIssue> {
    try {
        const selection = await resolvePlanIssueDefaultSelection({
            agent_alias: input.agent_alias ?? null,
            model_name: input.model_name ?? null
        });

        const [id] = await db('plan_issues').insert({
            draft_id: input.draft_id,
            repository: input.repository,
            issue_number: input.issue_number,
            agent_alias: selection.agent_alias,
            model_name: selection.model_name,
            run_ultrafix: input.run_ultrafix ?? null,
            ultrafix_goal: input.ultrafix_goal ?? null,
            ultrafix_max_cycles: input.ultrafix_max_cycles ?? null,
            status: PlanIssueStatus.PENDING,
            followup_count: 0,
            created_at: db.fn.now(),
            updated_at: db.fn.now()
        });

        const planIssue = await db('plan_issues').where({ id }).first();
        logger.info({ planIssue }, 'Created plan issue');
        return planIssue;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, input }, 'Failed to create plan issue');
        throw error;
    }
}

/**
 * Gets all plan issues for a draft.
 */
export async function getPlanIssuesByDraft(draftId: string): Promise<PlanIssue[]> {
    try {
        const issues = await db('plan_issues')
            .where({ draft_id: draftId })
            .orderBy('created_at', 'asc');
        return issues;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, draftId }, 'Failed to get plan issues by draft');
        return [];
    }
}

/**
 * Gets plan issues for a draft with pagination support.
 */
export async function getPlanIssuesByDraftPaginated(
    draftId: string,
    options: GetPlanIssuesOptions = {}
): Promise<PaginatedPlanIssuesResult> {
    const page = options.page ?? 0;
    const limit = Math.min(options.limit ?? 50, 100); // Cap at 100
    const offset = page * limit;

    try {
        let query = db('plan_issues').where({ draft_id: draftId });
        let countQuery = db('plan_issues').where({ draft_id: draftId });

        if (options.status) {
            query = query.andWhere({ status: options.status });
            countQuery = countQuery.andWhere({ status: options.status });
        }

        const [issues, countResult] = await Promise.all([
            query.orderBy('created_at', 'asc').limit(limit).offset(offset),
            countQuery.count('* as count').first()
        ]);

        const total = Number(countResult?.count ?? 0);

        return {
            issues,
            total,
            page,
            limit,
            hasMore: offset + issues.length < total
        };
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, draftId, options }, 'Failed to get paginated plan issues');
        return {
            issues: [],
            total: 0,
            page,
            limit,
            hasMore: false
        };
    }
}

/**
 * Gets a single plan issue by draft ID and issue number.
 */
export async function getPlanIssue(draftId: string, issueNumber: number): Promise<PlanIssue | null> {
    try {
        const issue = await db('plan_issues')
            .where({ draft_id: draftId, issue_number: issueNumber })
            .first();
        return issue || null;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, draftId, issueNumber }, 'Failed to get plan issue');
        return null;
    }
}

/**
 * Updates a plan issue.
 */
export async function updatePlanIssue(
    draftId: string,
    issueNumber: number,
    updates: UpdatePlanIssueInput
): Promise<PlanIssue | null> {
    try {
        const updateData: Record<string, unknown> = {
            updated_at: db.fn.now()
        };

        if (updates.pr_number !== undefined) updateData.pr_number = updates.pr_number;
        if (updates.status !== undefined) updateData.status = updates.status;
        if (updates.agent_alias !== undefined) updateData.agent_alias = updates.agent_alias;
        if (updates.model_name !== undefined) updateData.model_name = updates.model_name;
        if (updates.followup_count !== undefined) updateData.followup_count = updates.followup_count;
        if (updates.task_id !== undefined) updateData.task_id = updates.task_id;
        if (updates.run_ultrafix !== undefined) updateData.run_ultrafix = updates.run_ultrafix;
        if (updates.ultrafix_goal !== undefined) updateData.ultrafix_goal = updates.ultrafix_goal;
        if (updates.ultrafix_max_cycles !== undefined) updateData.ultrafix_max_cycles = updates.ultrafix_max_cycles;

        await db('plan_issues')
            .where({ draft_id: draftId, issue_number: issueNumber })
            .update(updateData);

        const issue = await db('plan_issues')
            .where({ draft_id: draftId, issue_number: issueNumber })
            .first();

        logger.info({ draftId, issueNumber, updates }, 'Updated plan issue');

        // Check and update draft status if issue status was changed
        if (updates.status !== undefined) {
            await checkAndUpdateDraftStatus(draftId);
        }

        return issue || null;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, draftId, issueNumber, updates }, 'Failed to update plan issue');
        throw error;
    }
}

/**
 * Increments the followup count for a plan issue.
 */
export async function incrementFollowupCount(draftId: string, issueNumber: number): Promise<void> {
    try {
        await db('plan_issues')
            .where({ draft_id: draftId, issue_number: issueNumber })
            .increment('followup_count', 1)
            .update({ updated_at: db.fn.now() });

        logger.info({ draftId, issueNumber }, 'Incremented plan issue followup count');
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, draftId, issueNumber }, 'Failed to increment followup count');
    }
}

/**
 * Finds a plan issue by repository and issue number.
 */
export async function findPlanIssueByRepoAndNumber(
    repository: string,
    issueNumber: number
): Promise<PlanIssue | null> {
    try {
        const issue = await db('plan_issues')
            .where({ repository, issue_number: issueNumber })
            .first();
        return issue || null;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, repository, issueNumber }, 'Failed to find plan issue by repo and number');
        return null;
    }
}

/**
 * Finds a plan issue by repository and PR number.
 */
export async function findPlanIssueByRepoAndPR(
    repository: string,
    prNumber: number
): Promise<PlanIssue | null> {
    try {
        const issue = await db('plan_issues')
            .where({ repository, pr_number: prNumber })
            .first();
        return issue || null;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, repository, prNumber }, 'Failed to find plan issue by repo and PR');
        return null;
    }
}

/**
 * Updates the status of a plan issue by repository and issue number.
 */
export async function updatePlanIssueStatus(
    repository: string,
    issueNumber: number,
    status: PlanIssueStatus
): Promise<void> {
    try {
        // Fetch the plan issue to get the draft_id for status sync
        const planIssue = await db('plan_issues')
            .where({ repository, issue_number: issueNumber })
            .select('draft_id')
            .first();

        await db('plan_issues')
            .where({ repository, issue_number: issueNumber })
            .update({
                status,
                updated_at: db.fn.now()
            });

        logger.info({ repository, issueNumber, status }, 'Updated plan issue status');

        // Check and update draft status after updating issue status
        if (planIssue?.draft_id) {
            await checkAndUpdateDraftStatus(planIssue.draft_id);
        }
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, repository, issueNumber, status }, 'Failed to update plan issue status');
    }
}

/**
 * Updates the task_id for a plan issue by repository and issue number.
 * Used when a task execution starts for a plan issue.
 */
export async function updatePlanIssueTaskId(
    repository: string,
    issueNumber: number,
    taskId: string
): Promise<void> {
    try {
        await db('plan_issues')
            .where({ repository, issue_number: issueNumber })
            .update({
                task_id: taskId,
                updated_at: db.fn.now()
            });

        logger.info({ repository, issueNumber, taskId }, 'Updated plan issue task_id');
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, repository, issueNumber, taskId }, 'Failed to update plan issue task_id');
    }
}

/**
 * Links a PR to a plan issue.
 */
export async function linkPRToPlanIssue(
    repository: string,
    issueNumber: number,
    prNumber: number
): Promise<void> {
    try {
        await db('plan_issues')
            .where({ repository, issue_number: issueNumber })
            .update({
                pr_number: prNumber,
                status: PlanIssueStatus.UNDER_REVIEW,
                updated_at: db.fn.now()
            });

        logger.info({ repository, issueNumber, prNumber }, 'Linked PR to plan issue');
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, repository, issueNumber, prNumber }, 'Failed to link PR to plan issue');
    }
}

/**
 * Updates a plan issue by repository and PR number.
 */
export async function updatePlanIssueByPR(
    repository: string,
    prNumber: number,
    updates: UpdatePlanIssueInput
): Promise<void> {
    try {
        // Fetch the plan issue to get the draft_id for status sync
        const planIssue = updates.status !== undefined
            ? await db('plan_issues')
                .where({ repository, pr_number: prNumber })
                .select('draft_id')
                .first()
            : null;

        const updateData: Record<string, unknown> = {
            updated_at: db.fn.now()
        };

        if (updates.status !== undefined) updateData.status = updates.status;
        if (updates.followup_count !== undefined) updateData.followup_count = updates.followup_count;

        await db('plan_issues')
            .where({ repository, pr_number: prNumber })
            .update(updateData);

        logger.info({ repository, prNumber, updates }, 'Updated plan issue by PR');

        // Check and update draft status after updating issue status
        if (planIssue?.draft_id) {
            await checkAndUpdateDraftStatus(planIssue.draft_id);
        }
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, repository, prNumber, updates }, 'Failed to update plan issue by PR');
    }
}

/**
 * Batch update agent/model for all issues in a draft.
 */
export interface BatchUpdatePlanIssueConfigInput {
    draftId: string;
    agentAlias?: string;
    modelName?: string;
    runUltrafix?: boolean | null;
    ultrafixGoal?: number | null;
    ultrafixMaxCycles?: number | null;
}

export async function batchUpdatePlanIssueConfig({
    draftId,
    agentAlias,
    modelName,
    runUltrafix,
    ultrafixGoal,
    ultrafixMaxCycles,
}: BatchUpdatePlanIssueConfigInput): Promise<void> {
    try {
        const updateData: Record<string, unknown> = {
            updated_at: db.fn.now()
        };

        if (agentAlias !== undefined) updateData.agent_alias = agentAlias;
        if (modelName !== undefined) updateData.model_name = modelName;
        if (runUltrafix !== undefined) updateData.run_ultrafix = runUltrafix;
        if (ultrafixGoal !== undefined) updateData.ultrafix_goal = ultrafixGoal;
        if (ultrafixMaxCycles !== undefined) updateData.ultrafix_max_cycles = ultrafixMaxCycles;

        await db('plan_issues')
            .where({ draft_id: draftId })
            .update(updateData);

        logger.info({ draftId, agentAlias, modelName, runUltrafix, ultrafixGoal, ultrafixMaxCycles }, 'Batch updated plan issue config');
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, draftId, agentAlias, modelName, runUltrafix, ultrafixGoal, ultrafixMaxCycles }, 'Failed to batch update plan issue config');
        throw error;
    }
}

/**
 * Deletes a plan issue.
 */
export async function deletePlanIssue(draftId: string, issueNumber: number): Promise<boolean> {
    try {
        const count = await db('plan_issues')
            .where({ draft_id: draftId, issue_number: issueNumber })
            .delete();

        logger.info({ draftId, issueNumber, deleted: count > 0 }, 'Deleted plan issue');
        return count > 0;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, draftId, issueNumber }, 'Failed to delete plan issue');
        throw error;
    }
}
