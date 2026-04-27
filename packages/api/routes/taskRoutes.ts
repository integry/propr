import crypto from 'node:crypto';
import { Request, Response } from 'express';
import { Knex } from 'knex';
import { Queue } from 'bullmq';
import { generateCorrelationId, getAuthenticatedOctokit, issueQueue, COMMENT_BATCH_DELAY_MS } from '@propr/core';
import type { SystemTaskJobData, CommentJobData, UnprocessedComment } from '@propr/core';
import { getTasksFromDb } from './taskHelpers.js';
import { validateTaskId, validateRepositoryFilter, validateStringLength, validatePositiveInteger } from './validation.js';

interface TaskRoutesDeps {
  db: Knex;
  taskQueue?: Queue;
}

interface TaskRecord {
  task_id: string;
  repository: string;
  issue_number: number;
  task_type: string;
}

interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string | null;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author?: {
      name?: string;
      email?: string;
      date?: string;
    } | null;
  };
  author?: {
    login?: string;
  } | null;
}

function formatCommit(c: GitHubCommit): CommitInfo {
  return {
    sha: c.sha,
    shortSha: c.sha.substring(0, 7),
    message: c.commit.message.split('\n')[0],
    author: c.commit.author?.name || c.author?.login || 'Unknown',
    date: c.commit.author?.date || null
  };
}

function validateRevertPreviewParams(query: Record<string, string>): { valid: true; params: { owner: string; repo: string; pr: string; commit: string } } | { valid: false; error: string } {
  const { owner, repo, pr, commit } = query;

  if (!owner || !repo || !pr || !commit) {
    return { valid: false, error: 'Missing required parameters: owner, repo, pr, commit' };
  }

  if (typeof owner !== 'string' || owner.length > 100) {
    return { valid: false, error: 'Invalid owner name' };
  }

  if (typeof repo !== 'string' || repo.length > 100) {
    return { valid: false, error: 'Invalid repo name' };
  }

  if (typeof commit !== 'string' || !/^[a-f0-9]{7,40}$/i.test(commit)) {
    return { valid: false, error: 'Invalid commit hash' };
  }

  return { valid: true, params: { owner, repo, pr, commit } };
}

export function createTaskRoutes(deps: TaskRoutesDeps) {
  const { db, taskQueue } = deps;

  async function getTasks(req: Request, res: Response): Promise<void> {
    try {
      const { status = 'all', repository = 'all', search = '', forReview = '', excludeMerged = '' } = req.query as Record<string, string>;

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

      if (!repo || !pr || !commit || !commentId || !owner) {
        res.status(400).json({
          error: 'Missing required parameters',
          required: ['repo', 'pr', 'commit', 'commentId', 'owner']
        });
        return;
      }

      // Validate repo name
      if (typeof repo !== 'string' || repo.length > 100) {
        res.status(400).json({ error: 'Invalid repo name' });
        return;
      }

      // Validate owner name
      if (typeof owner !== 'string' || owner.length > 100) {
        res.status(400).json({ error: 'Invalid owner name' });
        return;
      }

      // Validate PR number
      const prValidation = validatePositiveInteger(pr, 'PR number', { required: true, max: 10000000 });
      if (!prValidation.valid) {
        res.status(400).json({ error: prValidation.error });
        return;
      }

      // Validate commit hash
      if (typeof commit !== 'string' || !/^[a-f0-9]{7,40}$/i.test(commit)) {
        res.status(400).json({ error: 'Invalid commit hash' });
        return;
      }

      // Validate commentId
      const commentIdValidation = validatePositiveInteger(commentId, 'Comment ID', { required: true, max: 10000000000 });
      if (!commentIdValidation.valid) {
        res.status(400).json({ error: commentIdValidation.error });
        return;
      }

      const octokit = await getAuthenticatedOctokit();
      const prNumber = parseInt(pr, 10);

      const { data: prData } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: prNumber
      });

      const branch = prData.head.ref;
      const correlationId = generateCorrelationId();

      const requestingUser = (req.user as { username?: string })?.username || '';
      if (!requestingUser) {
        res.status(401).json({ error: 'Unable to determine requesting user' });
        return;
      }

      const systemTaskSecret = process.env.SYSTEM_TASK_SECRET;
      if (!systemTaskSecret) {
        console.error('[revert] SYSTEM_TASK_SECRET is not configured');
        res.status(503).json({ error: 'System task authorization is not configured' });
        return;
      }

      const authPayload = `revert:${owner}:${repo}:${prNumber}:${requestingUser}`;
      const hmac = crypto.createHmac('sha256', systemTaskSecret);
      hmac.update(authPayload);
      const authToken = hmac.digest('hex');

      const jobData: SystemTaskJobData = {
        type: 'revert',
        repoName: repo,
        prNumber,
        commitHash: commit,
        targetCommentId: parseInt(commentId, 10),
        prBranch: branch,
        owner: owner,
        correlationId,
        requestingUser,
        authToken
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

      const octokit = await getAuthenticatedOctokit();
      const prNumber = parseInt(pr, 10);

      const { data: prData } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: prNumber
      });

      const { data: prCommits } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
        owner, repo, pull_number: prNumber, per_page: 100
      });

      const targetCommitIndex = prCommits.findIndex(c => c.sha === commit || c.sha.startsWith(commit));

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
        targetCommit: { sha: commit, shortSha: commit.substring(0, 7) },
        newHead: newHeadCommit ? formatCommit(newHeadCommit) : null,
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

      const activeStates = ['pending', 'queued', 'processing', 'claude_execution', 'post_processing'];
      const forceDelete = force === 'true';

      if (activeStates.includes(latestState.state?.toLowerCase()) && !forceDelete) {
        res.status(400).json({
          error: 'Cannot delete task in active state',
          message: `Task is currently in "${latestState.state}" state. Please stop the task before deleting.`,
          currentState: latestState.state
        });
        return;
      }

      await db.transaction(async (trx) => {
        await trx('llm_execution_details')
          .whereIn('execution_id', function() {
            this.select('execution_id').from('llm_executions').where({ task_id: taskId });
          })
          .delete();
        await trx('llm_executions').where({ task_id: taskId }).delete();
        await trx('task_history').where({ task_id: taskId }).delete();
        await trx('tasks').where({ task_id: taskId }).delete();
      });

      res.status(204).send();
    } catch (error) {
      console.error('Error deleting task:', error);
      res.status(500).json({ error: 'Failed to delete task' });
    }
  }

  async function postFollowup(req: Request, res: Response): Promise<void> {
    try {
      const { taskId } = req.params;
      const { body } = req.body;

      // Validate taskId parameter
      const taskIdValidation = validateTaskId(taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      // Validate comment body
      const bodyValidation = validateStringLength(body, 'Comment body', { required: true, minLength: 1, maxLength: 65536 });
      if (!bodyValidation.valid) {
        res.status(400).json({ error: bodyValidation.error });
        return;
      }

      if (typeof body !== 'string' || body.trim().length === 0) {
        res.status(400).json({ error: 'Comment body is required' });
        return;
      }

      // Get task info from database
      const task = await db('tasks').where({ task_id: taskId }).first() as TaskRecord | undefined;
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const [repoOwner, repoName] = (task.repository as string).split('/');
      const issueNumber = task.issue_number;

      if (!repoOwner || !repoName || !issueNumber) {
        res.status(400).json({ error: 'Task does not have valid GitHub issue information' });
        return;
      }

      // Post comment to GitHub
      const octokit = await getAuthenticatedOctokit();
      const commentResponse = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repoOwner,
        repo: repoName,
        issue_number: issueNumber,
        body: body.trim()
      });

      const commentId = commentResponse.data.id;
      const commentAuthor = commentResponse.data.user?.login || 'unknown';

      console.log(`[followup] Posted follow-up comment (ID: ${commentId}) to ${repoOwner}/${repoName}#${issueNumber}`);

      // Get branch name for PR-based tasks
      let branchName: string | undefined;
      if (task.task_type === 'pr-comment') {
        try {
          const { data: prData } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: repoOwner,
            repo: repoName,
            pull_number: issueNumber
          });
          branchName = prData.head.ref;
        } catch (branchErr) {
          console.warn(`[followup] Could not fetch PR branch: ${(branchErr as Error).message}`);
        }
      }

      // Add comment directly to the processing queue (bypassing bot filter)
      const correlationId = generateCorrelationId();
      const unprocessedComment: UnprocessedComment = {
        id: commentId,
        body: body.trim(),
        author: commentAuthor,
        type: 'issue',
        hasCodeContext: false
      };

      const jobData: CommentJobData = {
        pullRequestNumber: issueNumber,
        comments: [unprocessedComment],
        repoOwner,
        repoName,
        branchName,
        correlationId
      };

      const timestamp = Date.now();
      const jobId = `pr-comments-batch-${repoOwner}-${repoName}-${issueNumber}-${timestamp}`;

      try {
        await issueQueue.add('processPullRequestComment', jobData, { jobId, delay: COMMENT_BATCH_DELAY_MS });
        console.log(`[followup] Queued follow-up comment for processing (jobId: ${jobId}, delay: ${COMMENT_BATCH_DELAY_MS}ms)`);
      } catch (queueErr) {
        const err = queueErr as Error;
        if (err.message?.includes('Job already exists')) {
          console.log(`[followup] Comment job already in queue, skipping`);
        } else {
          console.warn(`[followup] Failed to queue comment for processing: ${err.message}`);
        }
      }

      res.json({
        success: true,
        message: `Comment posted to ${repoOwner}/${repoName}#${issueNumber}`,
        commentId,
        jobId
      });
    } catch (error) {
      console.error('Error posting follow-up comment:', error);
      res.status(500).json({ error: 'Failed to post follow-up comment' });
    }
  }

  return { getTasks, revertChanges, getRevertPreview, deleteTask, postFollowup };
}
