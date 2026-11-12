import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { appendRepositoryEvent } from '../services/repositoryEventJournal.js';
import type { PlanIssueStatus } from './planIssueManager.js';

export async function notifyEpicQueue(draftId: string, issueNumber: number, status: PlanIssueStatus): Promise<void> {
    try {
        const { isTerminalStatus } = await import('../webhook/statusMachine.js');
        if (!isTerminalStatus(status)) return;
        const { onPlanIssueStatusChanged } = await import('../services/taskPlanning/epicExecutionQueue.js');
        await onPlanIssueStatusChanged(draftId, issueNumber, status);
    } catch (error) {
        logger.warn?.({ draftId, issueNumber, status, error: (error as Error).message }, 'Failed to notify epic queue');
    }
}

export interface PlanIssueJournalRow {
    id: number; draft_id: string; repository: string; issue_number: number; status: string | null; updated_at: unknown;
}

/**
 * The newest plan issue matching `where`, read before a status write so the
 * event knows the status it changed from. Never throws: a failed read only
 * costs the event, never the write.
 */
export async function readPlanIssueForJournal(where: Record<string, unknown>): Promise<PlanIssueJournalRow | null> {
    try {
        return await db('plan_issues').where(where).orderBy('id', 'desc')
            .first<PlanIssueJournalRow | undefined>('id', 'draft_id', 'repository', 'issue_number', 'status', 'updated_at') ?? null;
    } catch (error) {
        logger.warn?.({ ...where, error: (error as Error).message }, 'Could not read plan issue for its status event');
        return null;
    }
}

/**
 * Journal a persisted plan issue status change. A write that leaves the status
 * as it was (a redelivered webhook) appends nothing, and the key includes the
 * row's prior `updated_at`, so concurrent writers of one change share a key.
 * The plan activity event is already published by the status writers. Never throws.
 */
export async function journalPlanIssueStatus(before: PlanIssueJournalRow | null | undefined, to: string): Promise<void> {
    if (!before?.repository || before.id === undefined || before.status === to) return;
    const priorUpdate = before.updated_at instanceof Date ? before.updated_at.toISOString() : String(before.updated_at ?? '');
    await appendRepositoryEvent(db, {
        repository: before.repository, domain: 'plan_issue', type: 'status_changed', entityId: before.id,
        issueNumber: before.issue_number, planId: before.draft_id, payload: { from: before.status ?? null, to },
        dedupeKey: `plan_issue:${before.id}:status:${before.status ?? ''}:${to}:${priorUpdate}`,
    }, { publish: false });
}
