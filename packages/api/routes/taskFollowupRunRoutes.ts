import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { validateTaskId } from './validation.js';

/** A run a follow-up's issue retry started, as the page that sent it reads it. */
export interface FollowupRun {
  taskId: string;
  /** The run's latest recorded state, lowercased; `queued` until it records one. */
  status: string;
}

interface RetryJobData {
  retryCommentId?: unknown;
  retryRequesterId?: unknown;
}

function retryJobData(value: unknown): RetryJobData | null {
  if (value && typeof value === 'object') return value as RetryJobData;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as RetryJobData : null;
  } catch {
    return null;
  }
}

function commentIdOf(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The runs a follow-up's issue retry started. A run is this request's only
 * when it is another run of the same repository and issue, and the job that
 * started it carried the request's own comment for the signed-in requester:
 * another user's retry, a later trigger or an unrelated run of the issue is
 * never returned. It only reads what the worker recorded when the run began,
 * so a request whose run has not started yet has none; it never posts,
 * queues or changes anything.
 */
export async function findFollowupRuns(db: Knex, source: { task_id: string; repository: string; issue_number: number }, request: { commentId: number; userId: string }): Promise<FollowupRun[]> {
  const rows = await db('tasks')
    .where({ repository: source.repository, issue_number: source.issue_number })
    .whereNot({ task_id: source.task_id })
    .whereNotNull('replay_job_data')
    .select('task_id', 'replay_job_data') as Array<{ task_id: string; replay_job_data: unknown }>;
  const owned = rows.filter(row => {
    const data = retryJobData(row.replay_job_data);
    return data?.retryCommentId === request.commentId
      && data.retryRequesterId !== undefined && String(data.retryRequesterId) === request.userId;
  });
  const runs: FollowupRun[] = [];
  for (const row of owned) {
    const latest = await db('task_history').where({ task_id: row.task_id }).orderBy('history_id', 'desc').first('state') as { state?: string } | undefined;
    runs.push({ taskId: row.task_id, status: String(latest?.state ?? 'queued').toLowerCase() });
  }
  return runs.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export function createTaskFollowupRunRoutes({ db }: { db: Knex }) {
  async function getFollowupRuns(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unable to determine requesting user ID' });
        return;
      }
      const { taskId } = req.params;
      const taskIdValidation = validateTaskId(taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }
      const commentId = commentIdOf(req.query.commentId);
      if (commentId === null) {
        res.status(400).json({ error: 'commentId must be the positive comment ID the follow-up returned' });
        return;
      }
      const source = await db('tasks').where({ task_id: String(taskId) }).first('task_id', 'repository', 'issue_number') as
        { task_id: string; repository: string; issue_number: number | null } | undefined;
      if (!source) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      const runs = source.issue_number
        ? await findFollowupRuns(db, { ...source, issue_number: source.issue_number }, { commentId, userId: String(userId) })
        : [];
      res.json({ sourceTaskId: source.task_id, commentId, runs });
    } catch (error) {
      console.error('Error reading follow-up runs:', error);
      res.status(500).json({ error: 'Failed to read follow-up runs' });
    }
  }

  return { getFollowupRuns };
}
