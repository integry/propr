import type { Knex } from 'knex';
import logger from '../../utils/logger.js';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import type { EpicExecutionQueue, EpicQueueStatus } from './epicQueueState.js';

/**
 * Dispatch can create the epic and label its children even though saving the selector failed.
 * Save an externally verified selector only while the given execution still holds the obligation.
 */
export async function persistRecoveredEpicLabel(database: Knex, queue: EpicExecutionQueue, epicLabel: string,
  authority: { status: EpicQueueStatus; ready?: boolean }): Promise<boolean> {
  return database.transaction(async trx => {
    const draft = await trx('task_drafts').where({ draft_id: queue.draftId }).forUpdate().first('context_config');
    if (!draft) return false;
    const parsed = typeof draft.context_config === 'string' ? JSON.parse(draft.context_config || '{}') : draft.context_config;
    const context = parsed && typeof parsed === 'object' ? parsed : {};
    // A selector saved concurrently wins; a different branch must not be finalized as this one.
    if (typeof context.epicLabel === 'string') return context.epicLabel === epicLabel;
    return Boolean(await trx('task_drafts').where({ draft_id: queue.draftId })
      .whereExists(trx('epic_execution_queues').select('draft_id')
        .where({ draft_id: queue.draftId, execution_id: queue.executionId, ...authority }).whereNull('finalized_at'))
      .update({ context_config: JSON.stringify({ ...context, epicLabel }), updated_at: trx.fn.now() }));
  });
}

/**
 * A missing saved selector does not prove that no epic PR exists. Recover the branch from the
 * labels this execution's children carry; without one unambiguous selector, finalization stays owed.
 */
export async function recoverOwedEpicLabel(queue: EpicExecutionQueue, database: Knex): Promise<string | undefined> {
  const log = logger.withCorrelation(`epic-complete-${queue.draftId}`);
  // Children of a non-epic execution never carried the inherited epic's selector.
  if (!queue.useEpic) {
    log.warn({ draftId: queue.draftId }, 'Epic branch selector is missing; finalization remains owed');
    return undefined;
  }
  const [owner, repo] = queue.repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const found = new Set<string>();
  for (const issueNumber of queue.issues) {
    const issue = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issueNumber });
    for (const label of issue.data.labels) {
      const name = typeof label === 'string' ? label : label.name;
      if (name?.startsWith('base-')) found.add(name);
    }
  }
  const [epicLabel] = found;
  if (found.size !== 1 || !await persistRecoveredEpicLabel(database, queue, epicLabel, { status: 'completed' })) {
    log.warn({ draftId: queue.draftId, candidates: [...found] }, 'Epic branch selector could not be recovered; finalization remains owed');
    return undefined;
  }
  log.info({ draftId: queue.draftId, epicLabel }, 'Recovered epic branch selector from issue labels');
  return epicLabel;
}
