import { setOutcomeActivityPublisher, type CompletionLoader } from '../services/dashboardReadService.js';
/**
 * Dashboard read APIs.
 *
 * The dashboard answers four questions — what needs attention, what is
 * running, what was completed, and are things generally going well — from
 * three sources of truth: task state, completion events and aggregated execution
 * data. The first three live here; the historical stats section is served by
 * `getDashboardStats` in `statsRoutes.ts` so there is no fourth parallel stats
 * system.
 *
 * Attention is derived from work state, never from notification read or
 * dismissal state: dismissing a notification must not resolve a blocker.
 */

import { collectNarrativeFacts, createDashboardNarrative, type NarrativeModel } from './dashboardNarrative.js';
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import type { RedisClientType } from 'redis';
import { timeApiStage } from '../apiPerformanceTiming.js';
import { validatePositiveInteger, validateRepositoryFilter, validateStringLength } from './validation.js';
import {
  phaseLabel,
  RECENT_COMPLETION_WINDOW_HOURS,
  type DashboardTaskRow,
} from './dashboardQueries.js';
import { loadDashboardWork, loadRunningDashboardGoals } from './dashboardWorkQueries.js';
import { loadCompletedRows, loadOutcomeSummaries, loadOutcomeHistory, outcomeProjectionStatus, OutcomeProjectionError, type OutcomeUpdate, type OutcomeReadRow } from './dashboardOutcomeQueries.js';
import {
  EMPTY_LIVE_ACTIVITY,
  EMPTY_LIVE_DETAILS,
  MAX_LIVE_DETAIL_LOOKUPS,
  summariseLiveActivity,
  type LiveActivity,
  type LiveDetailsSnapshot,
} from './dashboardLiveActivity.js';

/** Where `src/worker.ts` heartbeats its identity and the concurrency it runs at. */
const WORKER_SET_KEY = 'system:status:workers';
const WORKER_CAPACITY_KEY = 'system:status:worker-capacity';
const DEFAULT_OUTCOME_LIMIT = 20;
const MAX_OUTCOME_LIMIT = 100;
const MAX_OUTCOME_SEARCH_LENGTH = 200;

export interface DashboardRoutesDeps {
  db: Knex;
  completedRows?: CompletionLoader;
  redisClient: RedisClientType;
  taskQueue: Pick<Queue, 'isPaused' | 'getActiveCount'>;
  /**
   * Seam for tests; production resolves the shared live-details projection.
   * Null is a stream that was not read, which is unknown rather than empty; a
   * stream read and found empty is an empty snapshot.
   */
  liveDetails?: (taskId: string) => Promise<LiveDetailsSnapshot | null>;
  now?: () => Date;
  narrativeModel?: NarrativeModel;
  isSummaryEnabled?: () => Promise<boolean>;
}

export interface ActiveItem {
  goalId?: string;
  id: string;
  taskId: string;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  /** The task's recorded type (`issue`, `pr-comment`, `review`…), when known. */
  taskType: string | null;
  title: string | null;
  state: string;
  phase: string | null;
  /** Latest meaningful progress line; null whenever the backend does not know one. */
  progressLine: string | null;
  /** The agent's latest action, from its most recent tool call; null when unknown. */
  activity: string | null;
  /** Position in the agent's own plan; null when it keeps none. */
  step: { current: number; total: number } | null;
  /** When the agent last produced output; null when the stream shows none. */
  lastActivityAt: string | null;
  /** The stream was read and holds no agent output yet; false when unknown. */
  awaitingFirstOutput: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The newest successful outcome for an entity, with its completed run count. */
export interface OutcomeItem {
  eventCount: number;
  entityId?: string;
  revision?: string;
  earlierUpdates?: Array<Omit<OutcomeItem, 'eventCount' | 'earlierUpdates'>>;
  id: string;
  taskId: string;
  repository: string;
  issueNumber: number | null;
  prNumber: number | null;
  taskType: string | null;
  title: string | null;
  /**
   * What the run produced — for a review, what it found. Null when nothing
   * was recorded beyond the fact that it finished.
   */
  detail: string | null;
  /** Review score out of 10. Only reviews are scored; null for everything else. */
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

export function toOutcomeUpdate(row: OutcomeUpdate) {
  return { id: `task:${row.taskId}:completed:${row.completionId}`, taskId: row.taskId,
    repository: row.repository, issueNumber: row.issueNumber, prNumber: row.prNumber,
    taskType: row.taskType, title: row.title, detail: row.recap,
    score: row.reviewScore, occurredAt: row.stateTimestamp };
}

export function toOutcomeItem(row: OutcomeReadRow): OutcomeItem {
  return { ...toOutcomeUpdate(row), eventCount: row.eventCount,
    ...(row.entityId ? { entityId: row.entityId, revision: row.revision } : {}),
    ...(row.earlierUpdates ? { earlierUpdates: row.earlierUpdates.map(toOutcomeUpdate) } : {}) };
}

export function createDashboardRoutes(deps: DashboardRoutesDeps) {
  const { db, redisClient, taskQueue } = deps;
  const completedRows: CompletionLoader = deps.completedRows ?? ((repository, options) => loadCompletedRows(db, repository, options));
  setOutcomeActivityPublisher(async repository => {
    await redisClient.publish('propr:events:activity', JSON.stringify({
      eventType: 'activity:update', domain: 'task', change: 'completed', repository: repository === '*' ? null : repository,
      entityId: 'dashboard-outcomes', terminal: true, occurredAt: new Date().toISOString(),
    }));
  });
  const now = deps.now ?? (() => new Date());
  // Loaded lazily so a dashboard read only reaches the live-details module
  // (and its provider parsers) when there is running work to project. A read
  // that fails rejects, and one that succeeds but finds no output at all is an
  // empty stream, so only a stream actually read can be reported as empty.
  const liveDetails = deps.liveDetails ?? (async (taskId: string): Promise<LiveDetailsSnapshot> => {
    const { projectTaskLiveDetails } = await import('./liveDetailsRoutes.js');
    return await projectTaskLiveDetails(redisClient, db, taskId, { rethrowReadErrors: true }) ?? EMPTY_LIVE_DETAILS;
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

  function toActiveItem(row: DashboardTaskRow, live: LiveActivity): ActiveItem {
    return {
      id: `task:${row.taskId}`,
      taskId: row.taskId,
      repository: row.repository,
      issueNumber: row.issueNumber,
      prNumber: row.prNumber,
      taskType: row.taskType,
      title: row.title,
      state: row.state,
      phase: phaseLabel(row.state),
      progressLine: live.progressLine,
      activity: live.activity,
      step: live.step,
      lastActivityAt: live.lastActivityAt,
      awaitingFirstOutput: live.awaitingFirstOutput,
      createdAt: row.createdAt,
      updatedAt: row.stateTimestamp,
    };
  }

  async function liveActivityFor(taskId: string): Promise<LiveActivity> {
    try {
      return summariseLiveActivity(await liveDetails(taskId));
    } catch {
      // An unreadable projection is unknown progress, not a failure.
      return EMPTY_LIVE_ACTIVITY;
    }
  }

  const narrative = createDashboardNarrative(deps.narrativeModel ?? (async () => null));

  async function getNarrative(req: Request, res: Response): Promise<void> {
    const repository = readRepositoryFilter(req, res);
    if (repository === null) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (deps.isSummaryEnabled && !await deps.isSummaryEnabled()) {
        res.json({ repository, enabled: false, summary: null });
        return;
      }
      const snapshot = await collectNarrativeFacts(db, repository, now(), {
        ownerId: req.user?.id ? String(req.user.id) : undefined,
        liveActivity: liveActivityFor,
        completedRows,
      });
      const summary = await narrative(snapshot, req.query.refresh === 'true');
      res.json({ repository, enabled: true, summary });
    } catch {
      // A transient data/model failure is unavailable, never a dashboard failure.
      res.json({ repository, enabled: true, summary: null });
    }
  }

  async function getSummary(req: Request, res: Response): Promise<void> {
    const repository = readRepositoryFilter(req, res);
    if (repository === null) return;
    try {
      const work = await timeApiStage('dashboard.summary', () =>
        loadDashboardWork(db, repository, { now: now(), ownerId: req.user?.id ? String(req.user.id) : null }));
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
        loadDashboardWork(db, repository, { now: now(), ownerId: req.user?.id ? String(req.user.id) : null }));
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
      const [work, goals] = await timeApiStage('dashboard.active', () => Promise.all([
        loadDashboardWork(db, repository, { now: now(), ownerId: req.user?.id ? String(req.user.id) : null }),
        loadRunningDashboardGoals(db, repository, req.user?.id ? String(req.user.id) : null),
      ]));
      const runningRows = [...work.running, ...goals]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

      const liveActivity = new Map<string, LiveActivity>();
      for (const row of runningRows.slice(0, MAX_LIVE_DETAIL_LOOKUPS)) {
        liveActivity.set(row.taskId, await liveActivityFor(row.taskId));
      }

      const running = runningRows.map(row => ({
        ...toActiveItem(row, liveActivity.get(row.taskId) ?? EMPTY_LIVE_ACTIVITY),
        ...('goalId' in row ? { id: `goal:${row.goalId}`, goalId: row.goalId } : {}),
      }));
      // Queued work has no execution to project progress from.
      const queued = work.queued.map(row => toActiveItem(row, EMPTY_LIVE_ACTIVITY));

      res.json({
        repository,
        running,
        queued,
        queue: {
          queuedCount: work.counts.queued,
          reason: await queueReason(work.counts.queued),
        },
        counts: { running: running.length, queued: work.counts.queued },
      });
    } catch (error) {
      console.error('Error in /api/dashboard/active:', error);
      res.status(500).json({ error: 'Failed to fetch active work' });
    }
  }

  async function getOutcomeHistory(req: Request, res: Response, options: { repository: string; limit: number }): Promise<void> {
    const { repository, limit } = options;
    const { entityId, revision, cursor } = req.query;
    if (typeof entityId !== 'string' || entityId.length > 100 || typeof revision !== 'string' || revision.length > 100
      || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048))) {
      res.status(400).json({ error: 'Invalid history reference' }); return;
    }
    const page = await timeApiStage('dashboard.outcomeHistory', () => loadOutcomeHistory(db, repository, entityId, revision,
      { limit, cursor: cursor as string | undefined }));
    res.json({ repository, entityId, revision, items: page.updates.map(toOutcomeUpdate), nextCursor: page.nextCursor });
  }

  async function getOutcomes(req: Request, res: Response): Promise<void> {
    const repository = readRepositoryFilter(req, res);
    if (repository === null) return;

    res.setHeader('Cache-Control', 'no-store');
    const vary = res.getHeader?.('Vary');
    res.setHeader('Vary', vary ? `${vary}, Accept` : 'Accept');
    const history = req.query.view === 'history';
    const limitValidation = validatePositiveInteger(req.query.limit, 'Limit', { max: history ? 50 : MAX_OUTCOME_LIMIT });
    if (!limitValidation.valid) {
      res.status(400).json({ error: limitValidation.error });
      return;
    }
    const limit = limitValidation.value || DEFAULT_OUTCOME_LIMIT;

    const searchValidation = validateStringLength(req.query.search, 'Search', { maxLength: MAX_OUTCOME_SEARCH_LENGTH });
    if (!searchValidation.valid) {
      res.status(400).json({ error: searchValidation.error });
      return;
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    try {
      if (req.query.view === 'status') { res.json(await outcomeProjectionStatus(db)); return; }
      if (history) {
        await getOutcomeHistory(req, res, { repository, limit });
        return;
      }
      const summaryRequested = req.query.view === 'summary'
        || req.headers?.accept?.includes('application/vnd.propr.outcome-summaries+json');
      const summary = summaryRequested && !['legacy', 'shadow'].includes(process.env.DASHBOARD_OUTCOME_PROJECTION ?? '');
      const rows = await timeApiStage<OutcomeReadRow[]>('dashboard.outcomes', async () => {
        if (summary) {
          try {
            return await (completedRows.summary ?? ((scope, options) => loadOutcomeSummaries(db, scope, options)))(repository, { limit, search });
          } catch (error) {
            if (!(error instanceof OutcomeProjectionError) || error.code !== 'OUTCOMES_NOT_READY') throw error;
            // Startup and rebuilds must keep serving completed work until the
            // projection is ready. Summary clients also accept embedded history.
          }
        }
        return completedRows(repository, { limit, search });
      });
      res.json({ repository, limit, search, items: rows.map(toOutcomeItem) });
    } catch (error) {
      if (error instanceof OutcomeProjectionError) {
        res.status(error.status).json({ error: error.code, code: error.code }); return;
      }
      console.error('Error in /api/dashboard/outcomes:', error);
      res.status(500).json({ error: 'Failed to fetch completed work' });
    }
  }

  return { getSummary, getAttention, getActive, getOutcomes, getNarrative };
}
