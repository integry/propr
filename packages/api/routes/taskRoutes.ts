import { deleteTaskRecords } from '../../core/src/storage/taskHistoryControl.js';
import { Request, Response } from 'express';
import { Queue } from 'bullmq';
import { getAuthenticatedOctokit, logger, syncTaskAssignees } from '@propr/core';
import { ACTIVE_TASK_LIFECYCLE_STATES, parseTaskAssignmentFilter } from '@propr/shared';
import { getTasksFromDb, type TaskQuery } from './taskHelpers.js';
import { validateTaskId, validateRepositoryFilter, validateStringLength, validatePositiveInteger } from './validation.js';
import { validateRevertRequestBody, formatCommit, validateRevertPreviewParams, checkRevertAuthorization, checkRevertPreviewAuthorization, lookupPr, buildRevertJobData, verifyCommitBelongsToPr, resolveRepoAndCheckAccess } from './revertHelpers.js';
import { createTaskFollowupRoutes, type TaskFollowupDeps } from './taskFollowupRoutes.js';
import { createTaskFollowupRunRoutes } from './taskFollowupRunRoutes.js';
export { resolveFollowupThread } from './taskFollowupRoutes.js';

interface TaskRoutesDeps extends TaskFollowupDeps {
  taskQueue?: Queue;
}

function taskGroupingError(groupBy: string, task: string): string | null {
  if (groupBy && groupBy !== 'task') return 'groupBy must be "task"';
  if (task && groupBy !== 'task') return 'task requires groupBy "task"';
  return null;
}

type AssignmentQuery = Pick<TaskQuery, 'assignee' | 'actingUserId' | 'syncAssignees'>;

/**
 * Reads the `assignee` and `syncAssignees` parameters of the task list. `me`
 * is whoever the session authenticates, so a client cannot read another
 * user's queue by editing the query string.
 */
function parseAssignmentQuery(req: Request, task: string): { ok: true; query: AssignmentQuery } | { ok: false; error: string } {
  const sync = req.query.syncAssignees === 'true';
  if (sync && !task) return { ok: false, error: 'syncAssignees requires task' };
  const parsed = parseTaskAssignmentFilter(req.query.assignee);
  if (!parsed.ok) return parsed;
  const actingUserId = req.user?.id ? String(req.user.id) : null;
  if (parsed.filter.mode === 'me' && !actingUserId) return { ok: false, error: 'assignee "me" requires an authenticated user' };
  return {
    ok: true,
    query: {
      assignee: parsed.filter,
      actingUserId,
      ...(sync ? { syncAssignees: (taskId: string) => syncTaskAssignees(taskId) } : {}),
    },
  };
}

export function createTaskRoutes(deps: TaskRoutesDeps) {
  const { db, taskQueue } = deps;

  async function getTasks(req: Request, res: Response): Promise<void> {
    try {
      const { status = 'all', repository = 'all', search = '', forReview = '', excludeMerged = '', groupBy = '', task = '' } = req.query as Record<string, string>;
      const groupingError = taskGroupingError(groupBy, task);
      if (groupingError) {
        res.status(400).json({ error: groupingError });
        return;
      }
      const assignment = parseAssignmentQuery(req, task);
      if (!assignment.ok) {
        res.status(400).json({ error: assignment.error });
        return;
      }

      // Validate limit parameter
      const limitValidation = validatePositiveInteger(req.query.limit, 'Limit', { max: 1000 });
      if (!limitValidation.valid) {
        res.status(400).json({ error: limitValidation.error });
        return;
      }
      const limit = limitValidation.value ?? 50;

      // Validate offset parameter
      const offsetValidation = validatePositiveInteger(req.query.offset, 'Offset', { max: 1000000 });
      if (!offsetValidation.valid) {
        res.status(400).json({ error: offsetValidation.error });
        return;
      }
      const offset = offsetValidation.value ?? 0;

      // Validate repository filter
      const repoValidation = validateRepositoryFilter(repository);
      if (!repoValidation.valid) {
        res.status(400).json({ error: repoValidation.error });
        return;
      }

      // Validate search parameter length
      const searchValidation = validateStringLength(search, 'Search', { maxLength: 500 });
      if (!searchValidation.valid) {
        res.status(400).json({ error: searchValidation.error });
        return;
      }

      const result = await getTasksFromDb({
        db,
        status,
        repository,
        limit,
        offset,
        search,
        forReview: forReview === 'true',
        excludeMerged: excludeMerged === 'true',
        groupByTask: groupBy === 'task',
        ...(task ? { containsTask: task } : {}),
        ...assignment.query,
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

      const bodyValidation = validateRevertRequestBody(req.body);
      if (!bodyValidation.valid) {
        res.status(400).json({ error: bodyValidation.error });
        return;
      }
      const { repo, pr, commit, commentId, owner } = bodyValidation.params;
      const prNumber = parseInt(pr, 10);
      const targetCommentIdNum = parseInt(commentId, 10);

      // --- Authorization gates (run before any GitHub API calls) ---

      const authResult = checkRevertAuthorization(req);
      if (!authResult.authorized) {
        res.status(authResult.status).json({ error: authResult.error });
        return;
      }
      const { requestingUser, systemTaskSecret } = authResult;
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unable to determine requesting user ID' });
        return;
      }

      // --- GitHub lookups (only after basic authorization passes) ---

      const prLookup = await lookupPr(owner, repo, prNumber, pr);
      if (!prLookup.success) {
        res.status(prLookup.status).json({ error: prLookup.error });
        return;
      }
      const { prData, octokit } = prLookup;

      if (req.body.expectedHead !== undefined && req.body.expectedHead !== prData.head.sha) {
        res.status(409).json({ error: 'Pull request head changed before revert could be queued' });
        return;
      }

      // Scope validation: verify the commit actually belongs to this PR and resolve to full SHA
      const commitCheck = await verifyCommitBelongsToPr({ octokit, owner, repo, prNumber, commit });
      if (!commitCheck.valid) {
        res.status(commitCheck.status).json({ error: commitCheck.error });
        return;
      }
      const resolvedCommit = commitCheck.resolvedSha;

      // Resolve target repo (handling forks) and verify access
      const repoAccess = await resolveRepoAndCheckAccess({ prData, owner, repo, pr, requestingUser, octokit });
      if (!repoAccess.ok) {
        res.status(repoAccess.status).json({ error: repoAccess.error });
        return;
      }

      const branch = prData.head.ref;
      const prHeadSha = prData.head.sha;

      const jobData = buildRevertJobData({
        owner, repo, prNumber, commit: resolvedCommit, targetCommentId: targetCommentIdNum,
        userId, requestingUser, systemTaskSecret, branch, prHeadSha,
        isFork: repoAccess.isFork, headRepoOwner: repoAccess.headRepoOwner, headRepoName: repoAccess.headRepoName
      });

      const job = await taskQueue.add('processSystemTask', jobData);

      logger.info({ jobId: job.id, pr, owner, repo, branch, isFork: repoAccess.isFork, headRepoOwner: repoAccess.headRepoOwner, headRepoName: repoAccess.headRepoName }, `[revert] Queued revert job ${job.id} for PR #${pr} in ${owner}/${repo}`);

      res.json({
        success: true,
        jobId: job.id,
        correlationId: jobData.correlationId,
        message: `Revert task queued for PR #${pr}`
      });
    } catch (error) {
      logger.error({ err: error }, 'Error in /api/tasks/revert');
      res.status(500).json({ error: 'Failed to queue revert task' });
    }
  }

  async function getRevertPreview(req: Request, res: Response): Promise<void> {
    try {
      const validation = validateRevertPreviewParams(req.query as Record<string, string>);
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const { owner, repo, pr, commit } = validation.params;

      // Validate PR number
      const prValidation = validatePositiveInteger(pr, 'PR number', { required: true, max: 10000000 });
      if (!prValidation.valid) {
        res.status(400).json({ error: prValidation.error });
        return;
      }

      // Authorization: whitelist check only — preview is read-only and does not require SYSTEM_TASK_SECRET
      const authResult = checkRevertPreviewAuthorization(req);
      if (!authResult.authorized) {
        res.status(authResult.status).json({ error: authResult.error });
        return;
      }

      const octokit = await getAuthenticatedOctokit();
      const prNumber = parseInt(pr, 10);

      const { data: prData } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: prNumber
      });

      // Resolve target repo (handling forks) and verify access
      const repoAccess = await resolveRepoAndCheckAccess({ prData, owner, repo, pr, requestingUser: authResult.requestingUser, octokit });
      if (!repoAccess.ok) {
        res.status(repoAccess.status).json({ error: repoAccess.error });
        return;
      }

      // Validate commit belongs to this PR, resolve full SHA, and reuse the fetched commits list
      const commitVerification = await verifyCommitBelongsToPr({ octokit, owner, repo, prNumber, commit });
      if (!commitVerification.valid) {
        res.status(commitVerification.status).json({ error: commitVerification.error });
        return;
      }
      const resolvedCommit = commitVerification.resolvedSha;
      const prCommits = commitVerification.prCommits;

      const targetCommitIndex = prCommits.findIndex(c => c.sha === resolvedCommit);

      if (targetCommitIndex === -1) {
        res.status(404).json({ error: 'Target commit not found in PR commits' });
        return;
      }

      const commitsToRemove = prCommits.slice(targetCommitIndex).map(formatCommit);
      const newHeadCommit = targetCommitIndex > 0 ? prCommits[targetCommitIndex - 1] : null;
      const remainingCommits = prCommits.slice(0, targetCommitIndex).map(formatCommit);

      res.json({
        branch: prData.head.ref,
        baseBranch: prData.base.ref,
        targetCommit: { sha: resolvedCommit, shortSha: resolvedCommit.substring(0, 7) },
        newHead: newHeadCommit ? formatCommit(newHeadCommit) : null,
        commitsToRemove,
        remainingCommits,
        willRevertToBase: targetCommitIndex === 0
      });
    } catch (error) {
      logger.error({ err: error }, 'Error in /api/tasks/revert-preview');
      res.status(500).json({ error: 'Failed to fetch revert preview' });
    }
  }

  async function deleteTask(req: Request, res: Response): Promise<void> {
    try {
      const { taskId } = req.params;
      const { force } = req.query;

      // Validate taskId parameter
      const taskIdValidation = validateTaskId(taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      const latestState = await db('task_history')
        .where({ task_id: taskId })
        .orderBy('timestamp', 'desc')
        .first();

      if (!latestState) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const forceDelete = force === 'true';

      if ((ACTIVE_TASK_LIFECYCLE_STATES as readonly string[]).includes(latestState.state?.toLowerCase()) && !forceDelete) {
        res.status(400).json({
          error: 'Cannot delete task in active state',
          message: `Task is currently in "${latestState.state}" state. Please stop the task before deleting.`,
          currentState: latestState.state
        });
        return;
      }

      await deleteTaskRecords(db, String(taskId));

      res.status(204).send();
    } catch (error) {
      console.error('Error deleting task:', error);
      res.status(500).json({ error: 'Failed to delete task' });
    }
  }

  return { getTasks, revertChanges, getRevertPreview, deleteTask, ...createTaskFollowupRoutes(deps), ...createTaskFollowupRunRoutes(deps) };
}
