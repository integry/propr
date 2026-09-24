/**
 * Dashboard read APIs.
 *
 * The dashboard answers four questions — what needs attention, what is
 * running, what just happened, and are things generally going well — from
 * three sources of truth: task state, outcome events and aggregated execution
 * data. The first three live here; the historical stats section is served by
 * `getDashboardStats` in `statsRoutes.ts` so there is no fourth parallel stats
 * system.
 *
 * Attention is derived from work state, never from notification read or
 * dismissal state: dismissing a notification must not resolve a blocker.
 */

import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import type { RedisClientType } from 'redis';
import { timeApiStage } from '../apiPerformanceTiming.js';
import { validatePositiveInteger, validateRepositoryFilter } from './validation.js';
import {
  phaseLabel,
  RECENT_COMPLETION_WINDOW_HOURS,
  type DashboardTaskRow,
} from './dashboardQueries.js';
import { loadDashboardWork } from './dashboardWorkQueries.js';
import {
  loadOutcomeRows,
  loadPlanIssueOutcomes,
  type OutcomeRow,
  type PlanIssueOutcomeRow,
} from './dashboardOutcomeQueries.js';

/** Running work we will pay for a live-details projection on in one request. */
const MAX_LIVE_DETAIL_LOOKUPS = 20;
/** Where `src/worker.ts` heartbeats its identity and the concurrency it runs at. */
const WORKER_SET_KEY = 'system:status:workers';
const WORKER_CAPACITY_KEY = 'system:status:worker-capacity';
const DEFAULT_OUTCOME_LIMIT = 20;
const MAX_OUTCOME_LIMIT = 100;

export interface DashboardRoutesDeps {
  db: Knex;
  redisClient: RedisClientType;
  taskQueue: Pick<Queue, 'isPaused' | 'getActiveCount'>;
  /** Seam for tests; production resolves the shared live-details projection. */
  liveDetails?: (taskId: string) => Promise<{ currentTask?: string | null } | null>;
  now?: () => Date;
}

export interface ActiveItem {
  id: string;
  taskId: string;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  title: string | null;
  state: string;
  phase: string | null;
  /** Latest meaningful progress line; null whenever the backend does not know one. */
  progressLine: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutcomeItem {
  id: string;
  kind: 'completed' | 'failed' | 'cancelled' | 'merged' | 'closed';
  taskId: string | null;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  title: string | null;
  detail: string | null;
  planIssueStatus: string | null;
  /** Implementation critique score out of 10; null whenever none was recorded. */
  score: number | null;
  occurredAt: string;
}

function readRepositoryFilter(req: Request, res: Response): string | null {
  const repository = typeof req.query.repository === 'string' ? req.query.repository : 'all';
  const validation = validateRepositoryFilter(repository);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error });
    return null;
  }
  return repository || 'all';
}

const outcomeKind = (state: string): OutcomeItem['kind'] =>
  state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'cancelled';

/**
 * A merge or a close is recorded after the implementation run already ended,
 * so it is its own outcome rather than a duplicate of that run's completion.
 */
function toPlanIssueOutcomeItem(row: PlanIssueOutcomeRow): OutcomeItem {
  return {
    id: `plan-issue:${row.id}:${row.status}`,
    kind: row.status === 'merged' ? 'merged' : 'closed',
    taskId: row.taskId,
    repository: row.repository,
    issueNumber: row.issueNumber,
    prNumber: row.prNumber,
    title: row.title,
    detail: row.status === 'merged' ? 'Pull request merged' : 'Closed without merging',
    planIssueStatus: row.status,
    score: null,
    occurredAt: row.occurredAt,
  };
}

function toOutcomeItem(row: OutcomeRow): OutcomeItem {
  return {
    id: `task:${row.taskId}:${row.state}`,
    kind: outcomeKind(row.state),
    taskId: row.taskId,
    repository: row.repository,
    issueNumber: row.issueNumber,
    prNumber: row.prNumber,
    title: row.title,
    detail: row.reason,
    planIssueStatus: row.planIssueStatus,
    score: row.score,
    occurredAt: row.stateTimestamp,
  };
}

export function createDashboardRoutes(deps: DashboardRoutesDeps) {
  const { db, redisClient, taskQueue } = deps;
  const now = deps.now ?? (() => new Date());
  // Loaded lazily so a dashboard read only reaches the live-details module
  // (and its provider parsers) when there is running work to project.
  const liveDetails = deps.liveDetails ?? (async (taskId: string) => {
    const { projectTaskLiveDetails } = await import('./liveDetailsRoutes.js');
    return projectTaskLiveDetails(redisClient, db, taskId);
  });

  /**
   * How many jobs the live workers can run at once, or null when that is not
   * knowable.
   *
   * Each worker publishes the concurrency it was started with beside its
   * heartbeat. A worker that is in the live set but has published no capacity
   * — an older build, or an entry whose capacity key has expired — makes the
   * total unknown rather than smaller: guessing low would let the dashboard
   * announce exhausted capacity that may not be exhausted.
   */
  async function workerCapacity(workerIds: readonly string[]): Promise<number | null> {
    const published = await redisClient.hGetAll(WORKER_CAPACITY_KEY) as Record<string, string>;
    let capacity = 0;
    for (const workerId of workerIds) {
      const reported = Number(published[workerId]);
      if (!Number.isFinite(reported) || reported <= 0) return null;
      capacity += reported;
    }
    return capacity;
  }

  /**
   * Why queued work is still queued, but only when the backend genuinely knows.
   *
   * A paused queue and an empty worker set are checked directly. "All agents
   * are busy" is a claim about capacity, so it is only made once the active
   * job count is compared with the capacity the live workers actually report:
   * one busy agent out of five is not a busy fleet, and saying so would
   * explain the wait with something the backend never verified.
   */
  async function queueReason(queuedCount: number): Promise<string | null> {
    if (queuedCount === 0) return null;
    try {
      if (await taskQueue.isPaused()) return 'Queue processing is paused';
      const workers = await redisClient.sMembers(WORKER_SET_KEY);
      if (workers.length === 0) return 'No workers are running';

      const capacity = await workerCapacity(workers);
      if (capacity === null) return null;
      return (await taskQueue.getActiveCount()) >= capacity ? 'All agents are busy' : null;
    } catch {
      return null;
    }
  }

  function toActiveItem(row: DashboardTaskRow, progressLine: string | null): ActiveItem {
    return {
      id: `task:${row.taskId}`,
      taskId: row.taskId,
      repository: row.repository,
      issueNumber: row.issueNumber,
      prNumber: row.prNumber,
      title: row.title,
      state: row.state,
      phase: phaseLabel(row.state),
      progressLine,
      createdAt: row.createdAt,
      updatedAt: row.stateTimestamp,
    };
  }

  async function progressLineFor(taskId: string): Promise<string | null> {
    try {
      const live = await liveDetails(taskId);
      const currentTask = live?.currentTask;
      return typeof currentTask === 'string' && currentTask.trim() ? currentTask : null;
    } catch {
      // An unreadable projection is an unknown progress line, not a failure.
      return null;
    }
  }

  async function getSummary(req: Request, res: Response): Promise<void> {
    const repository = readRepositoryFilter(req, res);
    if (repository === null) return;
    try {
      const work = await timeApiStage('dashboard.summary', () =>
        loadDashboardWork(db, repository, { now: now() }));
      res.json({
        repository,
        needsAttention: work.counts.needsAttention,
        running: work.counts.running,
        queued: work.counts.queued,
        completedRecently: work.counts.completedRecently,
        recentWindowHours: RECENT_COMPLETION_WINDOW_HOURS,
      });
    } catch (error) {
      console.error('Error in /api/dashboard/summary:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard summary' });
    }
  }

  async function getAttention(req: Request, res: Response): Promise<void> {
    const repository = readRepositoryFilter(req, res);
    if (repository === null) return;
    try {
      const work = await timeApiStage('dashboard.attention', () =>
        loadDashboardWork(db, repository, { now: now() }));
      const blocked = work.attention.filter(item => item.category === 'blocked').length;
      res.json({
        repository,
        items: work.attention,
        counts: {
          blocked,
          decisions: work.attention.length - blocked,
          total: work.attention.length,
        },
      });
    } catch (error) {
      console.error('Error in /api/dashboard/attention:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard attention' });
    }
  }

  async function getActive(req: Request, res: Response): Promise<void> {
    const repository = readRepositoryFilter(req, res);
    if (repository === null) return;
    try {
      const work = await timeApiStage('dashboard.active', () =>
        loadDashboardWork(db, repository, { now: now() }));

      const progressLines = new Map<string, string | null>();
      for (const row of work.running.slice(0, MAX_LIVE_DETAIL_LOOKUPS)) {
        progressLines.set(row.taskId, await progressLineFor(row.taskId));
      }

      const running = work.running.map(row => toActiveItem(row, progressLines.get(row.taskId) ?? null));
      // Queued work has no execution to project a progress line from.
      const queued = work.queued.map(row => toActiveItem(row, null));

      res.json({
        repository,
        running,
        queued,
        queue: {
          queuedCount: work.counts.queued,
          reason: await queueReason(work.counts.queued),
        },
        counts: { running: work.counts.running, queued: work.counts.queued },
      });
    } catch (error) {
      console.error('Error in /api/dashboard/active:', error);
      res.status(500).json({ error: 'Failed to fetch active work' });
    }
  }

  async function getOutcomes(req: Request, res: Response): Promise<void> {
    const repository = readRepositoryFilter(req, res);
    if (repository === null) return;

    const limitValidation = validatePositiveInteger(req.query.limit, 'Limit', { max: MAX_OUTCOME_LIMIT });
    if (!limitValidation.valid) {
      res.status(400).json({ error: limitValidation.error });
      return;
    }
    const limit = limitValidation.value || DEFAULT_OUTCOME_LIMIT;

    try {
      const [taskRows, planIssueRows] = await timeApiStage('dashboard.outcomes', () => Promise.all([
        loadOutcomeRows(db, repository, { limit }),
        loadPlanIssueOutcomes(db, repository, { limit }),
      ]));
      const items = [...taskRows.map(toOutcomeItem), ...planIssueRows.map(toPlanIssueOutcomeItem)]
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .slice(0, limit);
      res.json({ repository, limit, items });
    } catch (error) {
      console.error('Error in /api/dashboard/outcomes:', error);
      res.status(500).json({ error: 'Failed to fetch recent outcomes' });
    }
  }

  return { getSummary, getAttention, getActive, getOutcomes };
}
