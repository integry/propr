import type { PlanTask } from '../../api/proprApi';
import { getOutlineTitle } from './planDisplayName';

export interface TaskPrerequisite {
  id: string;
  stepNumber: number;
  title: string;
}

/** Resolves each task's `dependsOn` ids to the steps they name, in plan order; unknown ids are skipped. */
export function resolveTaskPrerequisites(tasks: PlanTask[]): Map<string, TaskPrerequisite[]> {
  const steps = new Map(tasks.map((task, index) => [task.id, { id: task.id, stepNumber: index + 1, title: getOutlineTitle(task.title ?? '') }]));
  return new Map(tasks.map(task => [task.id, (task.dependsOn ?? [])
    .flatMap(id => { const step = steps.get(id); return step && id !== task.id ? [step] : []; })
    .sort((left, right) => left.stepNumber - right.stepNumber)]));
}
