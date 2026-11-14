import { prunePlanItemDependencies } from '@propr/shared';
import type { PlanTask } from '../api/proprApi';

/**
 * A `dependsOn` edge that cannot be stored while one of its two tasks is
 * deleted. It is kept so restoring the missing task reconnects the edge.
 */
export interface DetachedDependency {
  dependent: string;
  prerequisite: string;
}

export interface RestorableTask {
  task: PlanTask;
  index: number;
  /** Ids of tasks whose dependsOn named the task when it was deleted. */
  dependents?: string[];
}

const withDependencies = (task: PlanTask, dependsOn: string[]): PlanTask => {
  const updated: PlanTask = { ...task, dependsOn };
  if (dependsOn.length === 0) delete updated.dependsOn;
  return updated;
};

const sameEdge = (left: DetachedDependency, right: DetachedDependency) =>
  left.dependent === right.dependent && left.prerequisite === right.prerequisite;

/**
 * Puts a deleted task back into `plan` with every relationship that is valid
 * against the tasks present now. The restored task's own prerequisites and the
 * tasks that depended on it are reconnected when present; an edge whose other
 * end is still deleted is returned in `detached` instead, and is reconnected
 * when that task is restored too. A final prune drops any edge that edits made
 * in between turned into a cycle, so the result is always saveable.
 */
export function restoreDeletedTask(plan: PlanTask[], deleted: RestorableTask, detached: readonly DetachedDependency[]):
  { plan: PlanTask[]; detached: DetachedDependency[] } {
  const restoredId = deleted.task.id;
  const present = new Set(plan.map(task => task.id));
  present.add(restoredId);

  const remaining = detached.filter(edge => edge.dependent !== restoredId && edge.prerequisite !== restoredId);
  const detach = (edge: DetachedDependency) => {
    if (!remaining.some(existing => sameEdge(existing, edge))) remaining.push(edge);
  };

  const prerequisites = [...new Set([
    ...(deleted.task.dependsOn ?? []),
    ...detached.filter(edge => edge.dependent === restoredId).map(edge => edge.prerequisite),
  ])].filter(id => id !== restoredId);
  const kept = prerequisites.filter(id => present.has(id));
  prerequisites.filter(id => !present.has(id)).forEach(prerequisite => detach({ dependent: restoredId, prerequisite }));

  const dependents = new Set([
    ...(deleted.dependents ?? []),
    ...detached.filter(edge => edge.prerequisite === restoredId).map(edge => edge.dependent),
  ]);
  dependents.delete(restoredId);
  dependents.forEach(dependent => { if (!present.has(dependent)) detach({ dependent, prerequisite: restoredId }); });

  const newPlan = plan.map(task => dependents.has(task.id) && !task.dependsOn?.includes(restoredId)
    ? { ...task, dependsOn: [...(task.dependsOn ?? []), restoredId] } : task);
  // Insert at the original index, or at the end if the index is out of bounds
  newPlan.splice(Math.min(deleted.index, newPlan.length), 0, withDependencies(deleted.task, kept));
  return { plan: prunePlanItemDependencies(newPlan), detached: remaining };
}
