import type { Goal } from '../../api/goals';

/** Where a running item is presented: one-off tasks live under Tasks, everything else under Goals. */
export const goalPath = (goal: Pick<Goal, 'id' | 'kind'>) => goal.kind === 'task'
  ? `/tasks/run/${encodeURIComponent(goal.id)}`
  : `/goals/${encodeURIComponent(goal.id)}`;
