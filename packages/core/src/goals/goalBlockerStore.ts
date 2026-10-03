import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
    boundGoalBlockerText,
    GOAL_BLOCKER_SUMMARY_LIMIT,
    normalizeGoalBlockerQuestions,
} from '@propr/shared';
import type { GoalBlockerReport } from '../agents/types.js';
import { redactSecrets } from '../utils/github/secretRedaction.js';

/**
 * Lifecycle of persisted provider blockers (`goal_blockers`).
 *
 * A blocker is opened only by its own execution attempt, under that attempt's
 * fence, and closed on authoritative evidence: the provider resolved it, its
 * turn or attempt ended, or a newer attempt replaced the session. A closed row
 * is never reopened, so a repeated or delayed event cannot resurrect it.
 */

export interface GoalBlockerAttempt {
    goalId: string;
    taskId: string;
    generation: number;
    claimId: string;
}

export interface GoalBlockerOwner {
    owner_id: string;
    repository: string;
    session_id: string | null;
    agent_type: string;
}

/** Why a blocker stopped waiting. Stored verbatim for audit. */
export type GoalBlockerResolution =
    | 'provider_resolved'
    | 'turn_ended'
    | 'attempt_ended'
    | 'superseded_by_attempt'
    | 'goal_terminal';

/**
 * Open (or refresh) the blocker for one provider request. Returns false when
 * the request was already closed: a replayed request stays closed.
 */
export async function recordGoalBlocker(
    trx: Knex | Knex.Transaction,
    attempt: GoalBlockerAttempt,
    goal: GoalBlockerOwner,
    report: GoalBlockerReport,
): Promise<boolean> {
    const requestKey = report.requestKey.slice(0, 255);
    const existing = await trx('goal_blockers')
        .where({ goal_id: attempt.goalId, request_key: requestKey })
        .first('blocker_id', 'status', 'run_claim') as { blocker_id: string; status: string; run_claim: string } | undefined;
    if (existing) {
        if (existing.status !== 'open' || existing.run_claim !== attempt.claimId) return false;
        await trx('goal_blockers').where({ blocker_id: existing.blocker_id, status: 'open' })
            .update({ last_observed_at: trx.fn.now() });
        return true;
    }
    const questions = normalizeGoalBlockerQuestions(report.questions ?? []);
    await trx('goal_blockers').insert({
        blocker_id: randomUUID(),
        goal_id: attempt.goalId,
        owner_id: goal.owner_id,
        repository: goal.repository,
        task_id: attempt.taskId,
        run_generation: attempt.generation,
        run_claim: attempt.claimId,
        session_id: goal.session_id,
        turn_id: report.turnId ? report.turnId.slice(0, 255) : null,
        provider: goal.agent_type.slice(0, 50),
        category: report.category,
        source: report.source.slice(0, 100),
        request_key: requestKey,
        summary: boundGoalBlockerText(redactSecrets(report.summary), GOAL_BLOCKER_SUMMARY_LIMIT),
        questions: questions.length ? JSON.stringify(questions) : null,
        response_actions: JSON.stringify(report.responseActions),
        status: 'open',
    });
    return true;
}

/** Close one open blocker raised by this attempt. */
export async function resolveGoalBlocker(
    database: Knex | Knex.Transaction,
    attempt: Pick<GoalBlockerAttempt, 'goalId' | 'claimId'>,
    requestKey: string,
    resolution: GoalBlockerResolution | string,
): Promise<boolean> {
    return await database('goal_blockers').where({
        goal_id: attempt.goalId,
        request_key: requestKey.slice(0, 255),
        run_claim: attempt.claimId,
        status: 'open',
    }).update({
        status: 'resolved',
        resolution: resolution.slice(0, 50),
        resolved_at: database.fn.now(),
    }) > 0;
}

/**
 * Close every open blocker of a goal, or only one attempt's (`claim`), or
 * every attempt but one (`exceptClaim`).
 */
export async function closeGoalBlockers(
    database: Knex | Knex.Transaction,
    goalId: string,
    scope: { claim?: string | null; exceptClaim?: string | null },
    resolution: GoalBlockerResolution,
): Promise<number> {
    const query = database('goal_blockers').where({ goal_id: goalId, status: 'open' });
    if (scope.claim) query.where('run_claim', scope.claim);
    if (scope.exceptClaim) query.whereNot('run_claim', scope.exceptClaim);
    return await query.update({
        status: resolution === 'provider_resolved' || resolution === 'turn_ended' ? 'resolved' : 'superseded',
        resolution,
        resolved_at: database.fn.now(),
    });
}
