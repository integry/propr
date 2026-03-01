import { Request, Response } from 'express';
import { Knex } from 'knex';
import { Queue } from 'bullmq';
import { generateCorrelationId, getAuthenticatedOctokit, issueQueue, COMMENT_BATCH_DELAY_MS } from '@propr/core';
import type { SystemTaskJobData, CommentJobData, UnprocessedComment } from '@propr/core';
import { getTasksFromDb } from './taskHelpers.js';

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

      if (!repo || !pr || !commit || !commentId || !owner) {
        res.status(400).json({
          error: 'Missing required parameters',
          required: ['repo', 'pr', 'commit', 'commentId', 'owner']
        });
        return;
      }

      const octokit = await getAuthenticatedOctokit();
      const prNumber = parseInt(pr, 10);

      const { data: prData } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: prNumber
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

      const { data: prData } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: prNumber
      });

      const branch = prData.head.ref;
      const baseBranch = prData.base.ref;

      const { data: prCommits } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
        owner, repo, pull_number: prNumber, per_page: 100
      });

      const targetCommitIndex = prCommits.findIndex(c => c.sha === commit || c.sha.startsWith(commit));

      if (targetCommitIndex === -1) {
        res.status(404).json({ error: 'Target commit not found in PR commits' });
        return;
      }

      const commitsToRemove = prCommits.slice(targetCommitIndex).map(c => ({
        sha: c.sha,
        shortSha: c.sha.substring(0, 7),
        message: c.commit.message.split('\n')[0],
        author: c.commit.author?.name || c.author?.login || 'Unknown',
        date: c.commit.author?.date || null
      }));

      const newHeadCommit = targetCommitIndex > 0 ? prCommits[targetCommitIndex - 1] : null;

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
        targetCommit: { sha: commit, shortSha: commit.substring(0, 7) },
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

      if (!taskId) {
        res.status(400).json({ error: 'Task ID is required' });
        return;
      }

      if (!body || typeof body !== 'string' || body.trim().length === 0) {
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
