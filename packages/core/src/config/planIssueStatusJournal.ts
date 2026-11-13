import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { appendRepositoryEvent } from '../services/repositoryEventJournal.js';
import type { PlanIssueStatus } from './planIssueManager.js';

export async function notifyEpicQueue(draftId: string, issueNumber: number, status: PlanIssueStatus): Promise<void> {
    try {
        // Every status, also an in-progress one: a graph execution counts an issue a person started.
        const { onPlanIssueStatusChanged } = await import('../services/taskPlanning/epicExecutionQueue.js');
        await onPlanIssueStatusChanged(draftId, issueNumber, status);
    } catch (error) {
        logger.warn?.({ draftId, issueNumber, status, error: (error as Error).message }, 'Failed to notify epic queue');
    }
}

export interface PlanIssueJournalRow {
    id: number; draft_id: string; repository: string; issue_number: number; status: string | null;
}

/** Narrows `plan_issues` to the rows a write targets, including any guard the write applies. */
export type PlanIssueScope = (rows: Knex.QueryBuilder) => Knex.QueryBuilder;

/**
 * Apply one plan issue update and journal every status change it makes, in a
 * single transaction: the rows the update changes, and the status each held
 * immediately before, are read inside that transaction with the update's own
 * filters, so the events describe exactly the rows the update changed and the
 * status it changed them from. A row already at the new status (a redelivered
 * webhook) appends nothing. Each actual transition is its own event, however
 * quickly the status returns to an earlier value: the event's `seq` is its
 * identity, so no timestamp-based key can merge two transitions.
 *
 * Without a status change the update runs alone. A failed append is logged
 * by the journal and leaves the update in place. Returns the rows updated.
 */
export async function updatePlanIssuesWithStatusJournal(
    scope: PlanIssueScope, updateData: Record<string, unknown>, status: string | undefined,
): Promise<number> {
    if (status === undefined) return Number(await scope(db('plan_issues')).update(updateData));
    return db.transaction(async trx => {
        const before = await scope(trx('plan_issues'))
            .select<PlanIssueJournalRow[]>('id', 'draft_id', 'repository', 'issue_number', 'status');
        if (!before.length) return 0;
        const updated = Number(await scope(trx('plan_issues')).whereIn('id', before.map(row => row.id)).update(updateData));
        for (const row of before) {
            if (!row.repository || row.status === status) continue;
            await appendRepositoryEvent(trx, {
                repository: row.repository, domain: 'plan_issue', type: 'status_changed', entityId: row.id,
                issueNumber: row.issue_number, planId: row.draft_id, payload: { from: row.status ?? null, to: status },
            }, { publish: false });
        }
        return updated;
    });
}
