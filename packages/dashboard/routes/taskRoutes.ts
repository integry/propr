import { Request, Response } from 'express';
import { Knex } from 'knex';
import { Queue } from 'bullmq';
import { generateCorrelationId, getAuthenticatedOctokit } from '@gitfix/core';
import type { SystemTaskJobData } from '@gitfix/core';

interface TaskRoutesDeps {
  db: Knex;
  taskQueue?: Queue;
}

export function createTaskRoutes(deps: TaskRoutesDeps) {
  const { db, taskQueue } = deps;

  async function getTasks(req: Request, res: Response): Promise<void> {
    try {
      const { status = 'all', limit = '50', offset = '0', repository = 'all', search = '', forReview = '', excludeMerged = '' } = req.query as Record<string, string>;

      const result = await getTasksFromDb({
        db,
        status,
        repository,
        limit: parseInt(limit),
        offset: parseInt(offset),
        search,
        forReview: forReview === 'true',
        excludeMerged: excludeMerged === 'true'
      });
      res.json(result);
    } catch (error) {
      console.error('Error in /api/tasks:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function revertChanges(req: Request, res: Response): Promise<void> {
    try {
      if (!taskQueue) {
        res.status(503).json({ error: 'Task queue not available' });
        return;
      }

      const { repo, pr, commit, commentId, owner } = req.body;

      // Validate required parameters
      if (!repo || !pr || !commit || !commentId || !owner) {
        res.status(400).json({
          error: 'Missing required parameters',
          required: ['repo', 'pr', 'commit', 'commentId', 'owner']
        });
        return;
      }

      // Fetch branch from PR (same as getRevertPreview does)
      const octokit = await getAuthenticatedOctokit();
      const prNumber = parseInt(pr, 10);

      const { data: prData } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo,
        pull_number: prNumber
      });

      const branch = prData.head.ref;
      const correlationId = generateCorrelationId();

      const jobData: SystemTaskJobData = {
        type: 'revert',
        repoName: repo,
        prNumber,
        commitHash: commit,
        targetCommentId: parseInt(commentId, 10),
        prBranch: branch,
        owner: owner,
        correlationId
      };

      const job = await taskQueue.add('processSystemTask', jobData);

      console.log(`[revert] Queued revert job ${job.id} for PR #${pr} in ${owner}/${repo} (branch: ${branch})`);

      res.json({
        success: true,
        jobId: job.id,
        correlationId,
        message: `Revert task queued for PR #${pr}`
      });
    } catch (error) {
      console.error('Error in /api/tasks/revert:', error);
      res.status(500).json({ error: 'Failed to queue revert task' });
    }
  }

  async function getRevertPreview(req: Request, res: Response): Promise<void> {
    try {
      const { owner, repo, pr, commit } = req.query as Record<string, string>;

      if (!owner || !repo || !pr || !commit) {
        res.status(400).json({
          error: 'Missing required parameters',
          required: ['owner', 'repo', 'pr', 'commit']
        });
        return;
      }

      const octokit = await getAuthenticatedOctokit();
      const prNumber = parseInt(pr, 10);

      // Get PR details to find the branch
      const { data: prData } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo,
        pull_number: prNumber
      });

      const branch = prData.head.ref;
      const baseBranch = prData.base.ref;

      // Get commits on the PR
      const { data: prCommits } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      });

      // Find the target commit and determine which commits will be removed
      const targetCommitIndex = prCommits.findIndex(c => c.sha === commit || c.sha.startsWith(commit));

      if (targetCommitIndex === -1) {
        res.status(404).json({
          error: 'Target commit not found in PR commits'
        });
        return;
      }

      // Commits to be removed are those after the target commit (inclusive of target)
      const commitsToRemove = prCommits.slice(targetCommitIndex).map(c => ({
        sha: c.sha,
        shortSha: c.sha.substring(0, 7),
        message: c.commit.message.split('\n')[0], // First line only
        author: c.commit.author?.name || c.author?.login || 'Unknown',
        date: c.commit.author?.date || null
      }));

      // The new HEAD will be the commit before the target (if any)
      const newHeadCommit = targetCommitIndex > 0 ? prCommits[targetCommitIndex - 1] : null;

      // Commits that will remain (before target commit)
      const remainingCommits = prCommits.slice(0, targetCommitIndex).map(c => ({
        sha: c.sha,
        shortSha: c.sha.substring(0, 7),
        message: c.commit.message.split('\n')[0],
        author: c.commit.author?.name || c.author?.login || 'Unknown',
        date: c.commit.author?.date || null
      }));

      res.json({
        branch,
        baseBranch,
        targetCommit: {
          sha: commit,
          shortSha: commit.substring(0, 7)
        },
        newHead: newHeadCommit ? {
          sha: newHeadCommit.sha,
          shortSha: newHeadCommit.sha.substring(0, 7),
          message: newHeadCommit.commit.message.split('\n')[0],
          author: newHeadCommit.commit.author?.name || newHeadCommit.author?.login || 'Unknown',
          date: newHeadCommit.commit.author?.date || null
        } : null,
        commitsToRemove,
        remainingCommits,
        willRevertToBase: targetCommitIndex === 0
      });
    } catch (error) {
      console.error('Error in /api/tasks/revert-preview:', error);
      res.status(500).json({ error: 'Failed to fetch revert preview' });
    }
  }

  async function deleteTask(req: Request, res: Response): Promise<void> {
    try {
      const { taskId } = req.params;
      const { force } = req.query;

      if (!taskId) {
        res.status(400).json({ error: 'Task ID is required' });
        return;
      }

      // Get the latest task state from task_history
      const latestState = await db('task_history')
        .where({ task_id: taskId })
        .orderBy('timestamp', 'desc')
        .first();

      if (!latestState) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      // Define active states that prevent deletion (unless force=true)
      const activeStates = ['pending', 'queued', 'processing', 'claude_execution', 'post_processing'];

      // Allow force deletion when the stop operation failed (e.g., task is stuck in pending but not actually running)
      const forceDelete = force === 'true';

      if (activeStates.includes(latestState.state?.toLowerCase()) && !forceDelete) {
        res.status(400).json({
          error: 'Cannot delete task in active state',
          message: `Task is currently in "${latestState.state}" state. Please stop the task before deleting.`,
          currentState: latestState.state
        });
        return;
      }

      // Use a transaction to delete from all related tables
      await db.transaction(async (trx) => {
        // Delete from llm_execution_details first (foreign key dependency)
        await trx('llm_execution_details')
          .whereIn('execution_id', function() {
            this.select('execution_id').from('llm_executions').where({ task_id: taskId });
          })
          .delete();

        // Delete from llm_executions
        await trx('llm_executions').where({ task_id: taskId }).delete();

        // Delete from task_history
        await trx('task_history').where({ task_id: taskId }).delete();

        // Delete the task itself
        await trx('tasks').where({ task_id: taskId }).delete();
      });

      res.status(204).send();
    } catch (error) {
      console.error('Error deleting task:', error);
      res.status(500).json({ error: 'Failed to delete task' });
    }
  }

  return { getTasks, revertChanges, getRevertPreview, deleteTask };
}

interface TaskQuery {
  db: Knex;
  status: string;
  repository: string;
  limit: number;
  offset: number;
  search?: string;
  forReview?: boolean;
  excludeMerged?: boolean;
}

async function getTasksFromDb(
  query: TaskQuery
): Promise<{ tasks: unknown[]; total: number; offset: number; limit: number }> {
  const { db, status, repository, limit, offset, search, forReview, excludeMerged } = query;
  const latestHistorySubquery = db('task_history')
    .select(
      'task_id',
      'state',
      'timestamp',
      'reason',
      db.raw('ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY timestamp DESC) as rn')
    )
    .as('h');

  const processingStartSubquery = db('task_history')
    .select(
      'task_id',
      db.raw('MIN(timestamp) as processing_start_timestamp')
    )
    .whereIn('state', ['processing', 'claude_execution', 'post_processing'])
    .groupBy('task_id')
    .as('ps');

  const completionSubquery = db('task_history')
    .select(
      'task_id',
      db.raw('MIN(timestamp) as completion_timestamp')
    )
    .whereIn('state', ['completed', 'failed', 'cancelled'])
    .groupBy('task_id')
    .as('cs');

  // Subquery to get plan_issue_status from plan_issues table
  const planIssueStatusSubquery = db('plan_issues')
    .select('task_id', 'status as plan_issue_status')
    .whereNotNull('task_id')
    .as('pi');

  // Subquery to get critique_score from the latest llm_execution per task
  // The analysis_report is a JSON object with a "report" field that contains the LLM response
  // The LLM response is wrapped in a markdown code block: ```json\n{...}\n```
  // We need to strip the markdown formatting to extract the actual JSON and parse it
  // Strategy: Use RTRIM to remove trailing whitespace and backticks, find first '{', extract from there
  const critiqueScoreSubquery = db.raw(`
    (SELECT
      task_id,
      CASE
        WHEN json_valid(analysis_report) = 1
          AND json_extract(analysis_report, '$.report') IS NOT NULL
          AND INSTR(json_extract(analysis_report, '$.report'), '{') > 0
        THEN (
          SELECT
            CASE
              WHEN json_valid(clean_json) = 1
              THEN json_extract(clean_json, '$.implementation_critique_score')
              ELSE NULL
            END
          FROM (
            SELECT RTRIM(
              SUBSTR(
                json_extract(analysis_report, '$.report'),
                INSTR(json_extract(analysis_report, '$.report'), '{')
              ),
              CHAR(10) || CHAR(13) || ' ' || '\`'
            ) as clean_json
          )
        )
        ELSE NULL
      END as critique_score
    FROM llm_executions le1
    WHERE analysis_report IS NOT NULL
      AND json_valid(analysis_report) = 1
      AND json_extract(analysis_report, '$.report') IS NOT NULL
      AND execution_id = (
        SELECT MAX(le2.execution_id)
        FROM llm_executions le2
        WHERE le2.task_id = le1.task_id
          AND le2.analysis_report IS NOT NULL
          AND json_valid(le2.analysis_report) = 1
      )
    ) as cs_score
  `);

  const baseQuery = db('tasks as t')
    .join(latestHistorySubquery, function() {
      this.on('t.task_id', '=', 'h.task_id').andOn('h.rn', '=', db!.raw('?', [1]));
    })
    .leftJoin(processingStartSubquery, 'ps.task_id', 't.task_id')
    .leftJoin(completionSubquery, 'cs.task_id', 't.task_id')
    .leftJoin(planIssueStatusSubquery, 'pi.task_id', 't.task_id')
    .leftJoin(critiqueScoreSubquery, 'cs_score.task_id', 't.task_id');

  if (status && status !== 'all') {
    baseQuery.where('h.state', status);
  }

  if (repository && repository !== 'all') {
    baseQuery.where('t.repository', repository);
  }

  // Search filter: matches repository, issue_number (cast to text), or initial_job_data JSON
  if (search && search.trim() !== '') {
    const searchTerm = `%${search.trim()}%`;
    baseQuery.where(function() {
      this.where('t.repository', 'like', searchTerm)
        .orWhere(db.raw('CAST(t.issue_number AS TEXT)'), 'like', searchTerm)
        .orWhere('t.initial_job_data', 'like', searchTerm);
    });
  }

  // For review filter: only include completed or failed tasks that need review
  // This filters at DB level to reduce post-processing
  if (forReview) {
    baseQuery.whereIn('h.state', ['completed', 'failed']);
  }

  // Exclude tasks where plan_issue_status is 'merged'
  // This helps get more consistent results by filtering out merged items at DB level
  if (excludeMerged) {
    baseQuery.where(function() {
      this.whereNull('pi.plan_issue_status')
        .orWhereNot('pi.plan_issue_status', 'merged');
    });
  }

  const totalResult = await baseQuery.clone().count('* as total').first();
  const total = parseInt(String(totalResult?.total || 0), 10);

  const dbTasks = await baseQuery
    .select('t.*', 'h.state', 'h.timestamp as state_timestamp', 'h.reason as failedReason',
            'ps.processing_start_timestamp', 'cs.completion_timestamp',
            'pi.plan_issue_status', 'cs_score.critique_score')
    .orderBy('t.created_at', 'desc')
    .limit(limit)
    .offset(offset);

  const tasks = dbTasks.map((row: Record<string, unknown>) => mapDbTaskToResponse(row));

  return { tasks, total, offset, limit };
}

function parseRepositoryParts(repository: unknown): { owner: string | null; name: string | null } {
  if (repository && typeof repository === 'string') {
    const parts = repository.split('/');
    if (parts.length === 2) {
      return { owner: parts[0], name: parts[1] };
    }
  }
  return { owner: null, name: null };
}

function parseInitialJobData(row: Record<string, unknown>): {
  title: string | null;
  subtitle: string | null;
  llmProvider: string | null;
  prNumber: number | null;
  issueNumber: number | null;
} {
  const result = { title: null as string | null, subtitle: null as string | null, llmProvider: null as string | null, prNumber: null as number | null, issueNumber: null as number | null };

  if (!row.initial_job_data) {
    return result;
  }

  try {
    const jobData = typeof row.initial_job_data === 'string'
      ? JSON.parse(row.initial_job_data)
      : row.initial_job_data;
    result.title = jobData.title || (jobData.issueRef ? jobData.issueRef.title : null) || null;
    result.subtitle = jobData.subtitle || null;
    result.llmProvider = jobData.agentAlias || null;
    if (jobData.pullRequestNumber) {
      result.prNumber = jobData.pullRequestNumber;
    }
    if (jobData.issueNumber) {
      result.issueNumber = jobData.issueNumber;
    }
  } catch (e) {
    console.error('Failed to parse initial_job_data', e);
  }

  return result;
}

function extractPrNumberFromFinalResult(row: Record<string, unknown>): number | null {
  if (!row.final_result) {
    return null;
  }

  try {
    const finalResult = typeof row.final_result === 'string'
      ? JSON.parse(row.final_result)
      : row.final_result;
    return finalResult?.postProcessing?.pr?.number || null;
  } catch {
    // Silently ignore parse errors for final_result
    return null;
  }
}

function mapDbTaskToResponse(row: Record<string, unknown>): Record<string, unknown> {
  const { owner: repositoryOwner, name: repositoryName } = parseRepositoryParts(row.repository);
  const { title, subtitle, llmProvider, prNumber: jobDataPrNumber, issueNumber: jobDataIssueNumber } = parseInitialJobData(row);
  // Priority: 1) pr_number column (new field), 2) initial_job_data.pullRequestNumber, 3) final_result.postProcessing.pr.number
  const prNumber = (row.pr_number as number | null) || jobDataPrNumber || extractPrNumberFromFinalResult(row);
  const linkedIssueNumber = jobDataIssueNumber;

  // Parse critique_score - it may come as a number or string from JSON extraction
  const critiqueScore = row.critique_score !== null && row.critique_score !== undefined
    ? typeof row.critique_score === 'number'
      ? row.critique_score
      : parseFloat(row.critique_score as string)
    : null;

  return {
    id: row.task_id,
    issueId: row.task_id,
    repository: row.repository,
    repositoryOwner: repositoryOwner,
    repositoryName: repositoryName,
    issueNumber: row.issue_number,
    prNumber: prNumber,
    linkedIssueNumber: linkedIssueNumber,
    title: title,
    subtitle: subtitle,
    status: row.state,
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt: row.completion_timestamp ? new Date(row.completion_timestamp as string).toISOString() : null,
    processedAt: row.processing_start_timestamp ? new Date(row.processing_start_timestamp as string).toISOString() : null,
    failedReason: row.state === 'failed' ? row.failedReason : null,
    progress: (row.state === 'completed' || row.state === 'failed' || row.state === 'cancelled') ? 100 : (row.state === 'processing' ? 50 : 0),
    attemptsMade: 1,
    modelName: row.model_name,
    model: row.model_name,
    llmProvider: llmProvider,
    planIssueStatus: row.plan_issue_status || null,
    critiqueScore: critiqueScore !== null && !isNaN(critiqueScore) ? critiqueScore : null
  };
}

