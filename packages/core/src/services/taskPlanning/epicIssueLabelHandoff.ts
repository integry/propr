import type { Knex } from 'knex';
import { blockQueueIssue, type EpicExecutionQueue, type QueueIssueRef } from './epicQueueState.js';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import { getPrimaryProcessingLabels } from '../../daemon/configLoader.js';
import { safeUpdateLabels } from '../../utils/github/labelOperations.js';
import logger from '../../utils/logger.js';
import { PlanIssueStatus } from '../../webhook/statusMachine.js';

/** Keep the issue unsettled until GitHub confirms its processing labels are released. */
export async function releaseEpicIssueLabels(queue: EpicExecutionQueue,
  { item, status, timestamp }: { item: QueueIssueRef; status: PlanIssueStatus; timestamp: number }, database: Knex): Promise<void> {
  const { issueNumber } = item;
  try {
    await releaseIssueLabels(queue.repository, issueNumber, status, database);
  } catch (error) {
    await blockQueueIssue(database, queue, item, { kind: 'label_handoff', timestamp,
      reason: `Could not release issue #${issueNumber}: ${(error as Error).message}` });
    throw error;
  }
}

const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'];

/** Whether an issue worker task for this issue has not reached a terminal state. */
async function hasUnfinishedIssueTask(database: Knex, repository: string, issueNumber: number): Promise<boolean> {
  const row = await database('tasks')
    .join('task_history', function latestState(this: Knex.JoinClause) {
      this.on('tasks.task_id', '=', 'task_history.task_id')
        .andOn('task_history.history_id', '=', database.raw('(SELECT MAX(th2.history_id) FROM task_history th2 WHERE th2.task_id = tasks.task_id)'));
    })
    .where({ 'tasks.repository': repository, 'tasks.issue_number': issueNumber, 'tasks.task_type': 'issue' })
    .whereNotIn('task_history.state', TERMINAL_TASK_STATES)
    .first('tasks.task_id');
  return !!row;
}

async function releaseIssueLabels(repository: string, issueNumber: number, status: PlanIssueStatus, database: Knex): Promise<void> {
  const [owner, repo] = repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const { data: issue } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
    owner, repo, issue_number: issueNumber,
  });
  const labels = new Set(issue.labels.map(label => typeof label === 'string' ? label : label.name));
  const configured = getPrimaryProcessingLabels();
  const primaryLabels = configured.length ? configured : ['AI'];
  // The queue applies only the first primary label. Another trigger is separate
  // work unless its own completion marker shows that work is finished too.
  const queueLabel = primaryLabels[0];
  const owned = primaryLabels.filter(label => label === queueLabel || labels.has(`${label}-done`));
  // A PR can merge before the worker publishes completion; its processing label
  // shows the worker may still be finishing, so do not release that job early.
  // The label alone is not proof: a worker whose done publication and processing
  // cleanup both failed has finished but leaves the same labels, so the wait lasts
  // only while an issue task is still unfinished. A bare trigger without the label
  // belongs to no running job (a stopped or failed run, or a PR a human fixed and
  // merged), so it is released rather than waited on forever.
  if (status === PlanIssueStatus.MERGED && labels.has(`${queueLabel}-processing`) && !labels.has(`${queueLabel}-done`)
    && await hasUnfinishedIssueTask(database, repository, issueNumber)) {
    throw new Error(`Waiting for '${queueLabel}-done' on issue #${issueNumber} before releasing its processing labels.`);
  }
  const remove = owned.flatMap(label => [label, `${label}-processing`]).filter(label => labels.has(label));
  if (!remove.length) return;
  const result = await safeUpdateLabels({ octokit, owner, repo, issueNumber,
    logger: logger.withCorrelation(`epic-handoff-${repository}-${issueNumber}`) }, remove, []);
  if (!result.success) throw new Error(result.errors.join('; '));
}
