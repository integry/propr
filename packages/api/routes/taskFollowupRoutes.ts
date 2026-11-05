import { commentAuthorMayFollowUp } from '../../core/src/webhook/followupAssignmentGate.js';
import { resolveGitHubMetadataToken, verifyGitHubRepositoryAccess, handleGitHubRepositoryAccessError } from '../githubMetadataAuth.js';
import { prepareApiFollowup } from '../../core/src/webhook/commentEventHandler.js';
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import { issueQueue, getAuthenticatedOctokit, generateCorrelationId, logger, dispatchPostedFollowup } from '@propr/core';
import { followupTargetsPullRequest, resolveFollowupThread, type FollowupTaskRecord } from './followupThread.js';
import { validateTaskId, validateStringLength } from './validation.js';
import { postIssueFollowup, type IssueFollowupDeps } from './taskIssueFollowup.js';

export interface TaskFollowupDeps extends IssueFollowupDeps {
  db: Knex;
  resolveMetadataToken?: typeof resolveGitHubMetadataToken;
  verifyRepositoryAccess?: typeof verifyGitHubRepositoryAccess;
  reviewAssignmentGate?: typeof commentAuthorMayFollowUp;
}

type TaskRecord = FollowupTaskRecord & { replay_job_data?: unknown };

export { followupTargetsPullRequest, resolveFollowupThread };

async function followupBranch(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
  context: { owner: string; repo: string; issueNumber: number },
): Promise<string | undefined> {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: context.owner, repo: context.repo, pull_number: context.issueNumber,
    });
    return data.head.ref;
  } catch (error) {
    console.warn(`[followup] Could not fetch PR branch: ${(error as Error).message}`);
    return undefined;
  }
}

function failedFollowupOutcome(submissionAttempted: boolean, jobId?: string) {
  return {
    success: false,
    state: submissionAttempted ? 'unknown' : 'failed',
    jobId,
    message: submissionAttempted
      ? 'Comment posted, but submission could not be confirmed. Inspect the comment and any job receipt before retrying.'
      : 'Comment posted, but the command failed before submission.',
  };
}

function validateFollowupRequest(req: Request, res: Response, reviewOnly: boolean) {
  const { taskId } = req.params;
  const { body, target } = reviewOnly ? { body: '/review', target: 'pull_request' } : req.body;
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unable to determine requesting user ID' });
    return undefined;
  }

  // Validate taskId parameter
  const taskIdValidation = validateTaskId(taskId);
  if (!taskIdValidation.valid) {
    res.status(400).json({ error: taskIdValidation.error });
    return undefined;
  }

  // Validate comment body
  const bodyValidation = validateStringLength(body, 'Comment body', { required: true, minLength: 1, maxLength: 65536 });
  if (!bodyValidation.valid) {
    res.status(400).json({ error: bodyValidation.error });
    return undefined;
  }

  if (typeof body !== 'string' || body.trim().length === 0) {
    res.status(400).json({ error: 'Comment body is required' });
    return undefined;
  }

  if (target !== undefined && target !== 'pull_request') {
    res.status(400).json({ error: 'Follow-up target must be "pull_request" when provided' });
    return undefined;
  }
  const targetsPullRequest = target === 'pull_request';

  return { taskId: String(taskId), body, userId, targetsPullRequest };
}

async function authorizeReview(
  req: Request, res: Response, deps: TaskFollowupDeps,
  context: { repoOwner: string; repoName: string; issueNumber: number; userId: string; task: TaskRecord },
): Promise<boolean> {
  const { repoOwner, repoName, issueNumber, userId, task } = context;
  // Use the person's grant and assignment, never the posting bot's authority.
  try {
    const token = await (deps.resolveMetadataToken ?? resolveGitHubMetadataToken)(req);
    await (deps.verifyRepositoryAccess ?? verifyGitHubRepositoryAccess)(task.repository, token);
  } catch (error) {
    if (await handleGitHubRepositoryAccessError(req, res, error)) return false;
    throw error;
  }
  const login = req.user?.login || req.user?.username;
  if (!login) {
    res.status(401).json({ error: 'Unable to determine requesting GitHub user' });
    return false;
  }
  const decision = await (deps.reviewAssignmentGate ?? commentAuthorMayFollowUp)({
    repoOwner, repoName, pullRequestNumber: issueNumber, authorId: String(userId), authorLogin: login,
  });
  if (!decision.allowed) {
    res.status(decision.reason === 'assignment_unavailable' ? 503 : 403).json({
      error: decision.reason === 'assignment_unavailable'
        ? 'Could not verify pull request assignment. Try again shortly.'
        : 'Only a user assigned to this pull request may request a review.',
    });
    return false;
  }
  const github = await getAuthenticatedOctokit();
  const { data: pr } = await github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: repoOwner, repo: repoName, pull_number: issueNumber,
  });
  if (pr.state !== 'open') {
    res.status(409).json({ error: 'Review requires an open pull request.' });
    return false;
  }
  return true;
}

/**
 * Resolves the pull request a follow-up continues, or responds directly when
 * the task cannot be followed up or the follow-up retries its issue instead.
 */
async function resolveFollowupContext(deps: TaskFollowupDeps, input: { taskId: string; body: string; userId: string; targetsPullRequest: boolean }, res: Response) {
  const { db } = deps;
  const { taskId, targetsPullRequest } = input;
  // Get task info from database
  const task = await db('tasks').where({ task_id: taskId }).first() as TaskRecord | undefined;
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return undefined;
  }

  const [repoOwner, repoName] = (task.repository as string).split('/');
  const thread = resolveFollowupThread(task, targetsPullRequest);
  const issueNumber = thread.number;

  if (!repoOwner || !repoName || !issueNumber) {
    res.status(400).json({ error: thread.error });
    return undefined;
  }

  if (!followupTargetsPullRequest(task, targetsPullRequest)) {
    // No PR exists, so PR-comment routing would target a nonexistent pull request.
    const outcome = await postIssueFollowup(db, deps, {
      task, owner: repoOwner, repo: repoName, issueNumber, body: input.body, userId: input.userId,
      redis: await issueQueue.client as unknown as Redis,
    });
    res.status(outcome.status).json(outcome.body);
    return undefined;
  }

  return { task, repoOwner, repoName, issueNumber };
}

function followupDispatchConfig() {
  return {
    PR_FOLLOWUP_TRIGGER_KEYWORDS: (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS ?? '').split(',').map(k => k.trim()).filter(Boolean),
    MODEL_LABEL_PATTERN: process.env.MODEL_LABEL_PATTERN || '^llm-(.+)$',
  };
}

export function createTaskFollowupRoutes(deps: TaskFollowupDeps) {
  async function postFollowup(req: Request, res: Response, reviewOnly = false): Promise<void> {
    let reviewRedis: Redis | undefined;
    let reviewKey: string | undefined;
    let reviewClaimed = false;
    let postAttempted = false;
    let commentRejected = false;
    const report = async (payload: Record<string, unknown>) => {
      let receipt = reviewOnly ? { ...payload, commandMode: 'review' } : payload;
      if (reviewRedis && reviewKey && reviewClaimed) {
        try {
          await reviewRedis.setex(reviewKey, 604800, JSON.stringify(receipt));
        } catch (error) {
          logger.warn({ err: error }, 'Could not persist review receipt');
          receipt = { ...receipt, success: false, state: 'unknown',
            message: 'Review receipt could not be saved. Inspect the pull request before retrying.' };
        }
      }
      res.status(202).json(receipt);
    };
    try {
      const input = validateFollowupRequest(req, res, reviewOnly);
      if (!input) return;
      const { taskId, body, userId, targetsPullRequest } = input;

      const context = await resolveFollowupContext(deps, { taskId, body, userId: String(userId), targetsPullRequest }, res);
      if (!context) return;
      const { task, repoOwner, repoName, issueNumber } = context;

      if (reviewOnly) {
        if (!await authorizeReview(req, res, deps, { repoOwner, repoName, issueNumber, userId, task })) return;
        reviewRedis = await issueQueue.client as unknown as Redis;
        // One review request per source run, shared across users, cards and retries.
        reviewKey = `task-review:${task.task_id}`;
        const pending = { success: false, state: 'unknown', commandMode: 'review', sourceTaskId: taskId,
          message: 'A review request for this run is already in progress. Refresh the task before retrying.' };
        if (!await reviewRedis.set(reviewKey, JSON.stringify(pending), 'EX', 604800, 'NX')) {
          const receipt = await reviewRedis.get(reviewKey);
          res.status(202).json(receipt ? JSON.parse(receipt) : pending);
          return;
        }
        reviewClaimed = true;
      }

      // Reserve API ownership before GitHub can emit the comment webhook.
      const redisClient = await issueQueue.client as unknown as Redis;
      const postedBody = await prepareApiFollowup(redisClient, { owner: repoOwner, repo: repoName, prNumber: issueNumber }, body.trim());

      // Post comment to GitHub
      const octokit = await getAuthenticatedOctokit();
      postAttempted = true;
      const commentResponse = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repoOwner,
        repo: repoName,
        issue_number: issueNumber,
        body: postedBody
      }).catch((error: unknown) => {
        const status = (error as { status?: number } | null)?.status;
        // Only a rejection of this POST proves no comment was created. A
        // timeout or server/transport failure can occur after GitHub accepts it.
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
          commentRejected = true;
          postAttempted = false;
        }
        throw error;
      });

      const commentId = commentResponse.data.id;
      const commentAuthor = commentResponse.data.user?.login || 'unknown';

      console.log(`[followup] Posted follow-up comment (ID: ${commentId}) to ${repoOwner}/${repoName}#${issueNumber}`);

      const branchName = await followupBranch(octokit, { owner: repoOwner, repo: repoName, issueNumber });

      const jobId = `pr-comments-batch-${repoOwner}-${repoName}-${issueNumber}-${Date.now()}-${commentId}`;
      let outcome;
      let submissionAttempted = false;
      let attemptedJobId: string | undefined;
      try {
        outcome = await dispatchPostedFollowup({
          owner: repoOwner, repo: repoName, prNumber: issueNumber, userId: String(userId), branchName,
          comment: {
            id: commentId, body: body.trim(),
            created_at: commentResponse.data.created_at,
            updated_at: commentResponse.data.updated_at,
            user: { login: commentAuthor, type: commentResponse.data.user?.type },
          },
        }, generateCorrelationId(), {
          // taskQueue constructs this client with ioredis; BullMQ exposes only IRedisClient.
          redisClient,
          ...followupDispatchConfig(),
          jobId,
          onSubmissionAttempt: id => { submissionAttempted = true; attemptedJobId = id; },
        });
      } catch (queueErr) {
        // Redis may have accepted the job before the connection failed. A posted
        // comment is not evidence of a successful submission; retain both handles.
        console.warn(`[followup] Command dispatch failed: ${(queueErr as Error).message}`);
        await report({ ...failedFollowupOutcome(submissionAttempted, attemptedJobId),
          posted: true, commentId, sourceTaskId: taskId });
        return;
      }
      await report({ success: ['queued', 'batched', 'handled'].includes(outcome.state), ...outcome, posted: true, commentId, sourceTaskId: taskId });
    } catch (error) {
      if (reviewRedis && reviewKey && reviewClaimed) {
        if (postAttempted) {
          await report({ success: false, state: 'unknown', sourceTaskId: req.params.taskId,
            message: 'Review submission could not be confirmed. Inspect the pull request before retrying.' });
          return;
        }
        await reviewRedis.del(reviewKey);
      }
      console.error('Error posting follow-up comment:', error);
      if (reviewOnly && commentRejected) {
        res.status(503).json({ success: false, state: 'failed', posted: false, commandMode: 'review',
          sourceTaskId: req.params.taskId, error: 'GitHub rejected the review comment. No review was submitted. Try again shortly.' });
        return;
      }
      res.status(500).json({ error: reviewOnly ? 'Review is unavailable right now. Check server connectivity and try again.' : 'Failed to post follow-up comment' });
    }
  }

  return {
    postFollowup: (req: Request, res: Response) => postFollowup(req, res),
    postReview: (req: Request, res: Response) => postFollowup(req, res, true),
  };
}
