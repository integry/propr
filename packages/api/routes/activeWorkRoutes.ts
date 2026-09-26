import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Job, Queue } from 'bullmq';
import { isDemoMode } from '../demoMode.js';

export const ACTIVE_WORK_DEFINITION =
  'Running non-goal tasks + generating or refining plans + executing native goals; open goals are reported separately';

const LEGACY_ACTIVE_WORK_DEFINITION =
  'Running tasks + generating or refining plans; open goals are reported separately';
const MAX_ACTIVE_WORK_COUNT = 1_000_000;

interface ActiveWorkRoutesDependencies {
  db: Knex;
  taskQueue: Pick<Queue, 'getJobs'>;
}

interface CountRow {
  count?: string | number;
}

interface GoalExecutionRow {
  goal_id: string;
  current_task_id: string;
  run_generation: number;
  run_claim: string | null;
}

interface GoalTableRow extends GoalExecutionRow {
  owner_id: string;
  desired_state: 'running' | 'paused' | 'cancelled';
  result_state: 'completed' | 'failed' | 'cancelled' | null;
}

type ActiveJob = Pick<Job, 'id' | 'name' | 'data'>;

const countActiveJobs = (jobs: readonly ActiveJob[], include: (job: ActiveJob) => boolean): number => {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (include(job) && typeof job.id === 'string' && job.id.length > 0) ids.add(job.id);
  }
  return ids.size;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const countExecutingGoals = (jobs: readonly ActiveJob[], goals: readonly GoalExecutionRow[]): number => {
  const current = new Map(goals.map(goal => [goal.goal_id, goal]));
  const executing = new Set<string>();
  for (const job of jobs) {
    if (job.name !== 'processGoal' || typeof job.id !== 'string' || job.id.length === 0 || !isRecord(job.data)) continue;
    if (typeof job.data.goalId !== 'string' || job.data.goalId.length === 0
      || typeof job.data.taskId !== 'string' || job.data.taskId.length === 0
      || !Number.isSafeInteger(job.data.generation) || (job.data.generation as number) < 0
      || typeof job.data.claimId !== 'string' || job.data.claimId.length === 0) continue;
    const goal = current.get(job.data.goalId);
    if (!goal
      || job.data.taskId !== goal.current_task_id
      || job.data.generation !== goal.run_generation
      || job.data.claimId !== goal.run_claim) continue;
    executing.add(goal.goal_id);
  }
  return executing.size;
};

const rowCount = (row: CountRow | undefined): number => {
  const count = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ACTIVE_WORK_COUNT) {
    throw new Error('Active work query returned an invalid count');
  }
  return count;
};

const validatedTotal = (...counts: number[]): number => {
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > MAX_ACTIVE_WORK_COUNT)) {
    throw new Error('Active work snapshot contains an invalid count');
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total) || total > MAX_ACTIVE_WORK_COUNT) {
    throw new Error('Active work snapshot total is too large');
  }
  return total;
};

/**
 * A single authenticated reconciliation snapshot for native desktop surfaces.
 * A v3 request opts into executing native goals. Goal execution requires both
 * an active processGoal queue attempt and its current running, nonterminal DB
 * lifecycle record. Standalone incomplete repository todos remain separately
 * labelled backlog. Issue and comment execution are instance-scoped: their
 * canonical queue data has no per-user recipient, matching the existing
 * instance-wide task API and task socket access. The shared count is exposed
 * only after the operational API boundary has authenticated the account and
 * resolved its instance authorization. Native goals are always owner-scoped.
 * Requests that do not opt into v3 retain the strict v2 response shape used by
 * installed desktop clients.
 */
export const createActiveWorkRoutes = ({ db, taskQueue }: ActiveWorkRoutesDependencies) => ({
  async getActiveWork(req: Request, res: Response): Promise<void> {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!req.authorization) {
      res.status(403).json({ error: 'Instance access required' });
      return;
    }

    try {
      const sharedInstance = isDemoMode();
      let plansQuery = db('task_drafts')
        .count('* as count')
        .whereIn('status', ['generating', 'refining']);
      let openGoalsQuery = db('repo_todos')
        .count('* as count')
        .where({ is_completed: false })
        .whereNull('linked_draft_id');
      if (!sharedInstance) {
        plansQuery = plansQuery.andWhere({ user_id: req.user.id });
        openGoalsQuery = openGoalsQuery.andWhere({ user_id: req.user.id });
      }

      const [activeJobs, planRow, openGoalRow, executingGoalRows] = await Promise.all([
        taskQueue.getJobs(['active']),
        plansQuery.first() as Promise<CountRow | undefined>,
        openGoalsQuery.first() as Promise<CountRow | undefined>,
        db<GoalTableRow>('goals')
          .select('goal_id', 'current_task_id', 'run_generation', 'run_claim')
          .where({ owner_id: req.user.id, desired_state: 'running' })
          .whereNull('result_state'),
      ]);
      const tasks = countActiveJobs(activeJobs, job => job.name !== 'processGoal');
      const plans = rowCount(planRow);
      const openGoals = rowCount(openGoalRow);
      const goals = countExecutingGoals(activeJobs, executingGoalRows);
      const total = validatedTotal(tasks, plans, goals);
      validatedTotal(openGoals);

      if (req.query.schemaVersion === '3') {
        res.json({
          schemaVersion: 3,
          label: 'Active work',
          definition: ACTIVE_WORK_DEFINITION,
          availability: {
            tasks: 'available',
            plans: 'available',
            goals: 'available',
            openGoals: 'available',
          },
          counts: { tasks, plans, goals, openGoals, total },
        });
        return;
      }

      // v2 has no goals field. Fold only this account's executing goals into
      // its legacy task total so installed clients preserve their badge count
      // without learning another owner's goal count.
      const legacyTasks = tasks + goals;
      res.json({
        schemaVersion: 2,
        label: 'Active work',
        definition: LEGACY_ACTIVE_WORK_DEFINITION,
        availability: {
          tasks: 'available',
          plans: 'available',
          goals: 'unsupported',
          openGoals: 'available',
        },
        counts: { tasks: legacyTasks, plans, goals: null, openGoals, total },
      });
    } catch (error) {
      console.error('Error in /api/desktop/active-work:', error);
      res.status(500).json({ error: 'Failed to fetch active work' });
    }
  },
});
