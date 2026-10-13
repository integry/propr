import { getTasks } from '../../api/proprApi';
import { buildTaskRow, buildTaskRuns, type TaskRunEntry } from '../TaskList/rowModel';
import type { TaskGroup } from '../TaskList/types';
import { groupTasksForDisplay } from '../TaskList/utils';

/** Every run of the task `taskId` belongs to, read now; null when the task is not found. */
export async function readTaskGroup(taskId: string): Promise<TaskGroup | null> {
  const data = await getTasks({ groupBy: 'task', task: taskId, limit: 1, offset: 0 });
  return groupTasksForDisplay(data.tasks ?? []).find(entry => entry.tasks.some(task => task.id === taskId)) ?? null;
}

/** The runs of a task group, oldest first. */
export const taskGroupRuns = (group: TaskGroup): TaskRunEntry[] => buildTaskRuns(buildTaskRow(group));

/** The runs of the task `taskId` belongs to, oldest first, read now; null when the task is not found. */
export async function readTaskRuns(taskId: string): Promise<TaskRunEntry[] | null> {
  const group = await readTaskGroup(taskId);
  return group ? taskGroupRuns(group) : null;
}
