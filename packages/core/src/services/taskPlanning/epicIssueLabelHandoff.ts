import type { Knex } from 'knex';
import type { EpicExecutionQueue } from './epicExecutionQueue.js';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import { getPrimaryProcessingLabels } from '../../daemon/configLoader.js';
import { safeUpdateLabels } from '../../utils/github/labelOperations.js';
import logger from '../../utils/logger.js';
import { PlanIssueStatus } from '../../webhook/statusMachine.js';

/** Keep the current queue head until GitHub confirms its processing labels are released. */
export async function releaseEpicIssueLabels(queue: EpicExecutionQueue, status: PlanIssueStatus, database: Knex, timestamp: number): Promise<void> {
  const issueNumber = queue.issues[queue.cursor];
  try {
    await releaseIssueLabels(queue.repository, issueNumber, status);
  } catch (error) {
    await database('epic_execution_queues').where({ draft_id: queue.draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor })
      .update({ blocked_reason: `Could not release issue #${issueNumber}: ${(error as Error).message}`, updated_at: timestamp });
    throw error;
  }
}

async function releaseIssueLabels(repository: string, issueNumber: number, status: PlanIssueStatus): Promise<void> {
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
  // shows the worker is still finishing, so do not release that job early. A bare
  // trigger without it belongs to no running job (a stopped or failed run, or a
  // PR a human fixed and merged), so it is released rather than waited on forever.
  if (status === PlanIssueStatus.MERGED && labels.has(`${queueLabel}-processing`) && !labels.has(`${queueLabel}-done`)) {
    throw new Error(`Waiting for '${queueLabel}-done' on issue #${issueNumber} before releasing its processing labels.`);
  }
  const remove = owned.flatMap(label => [label, `${label}-processing`]).filter(label => labels.has(label));
  if (!remove.length) return;
  const result = await safeUpdateLabels({ octokit, owner, repo, issueNumber,
    logger: logger.withCorrelation(`epic-handoff-${repository}-${issueNumber}`) }, remove, []);
  if (!result.success) throw new Error(result.errors.join('; '));
}
