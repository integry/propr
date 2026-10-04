import { useEffect, useState } from 'react';
import { getTasks } from '../api/proprApi';
import { groupTasksForDisplay } from '../components/TaskList/utils';
import type { TaskGroup } from '../components/TaskList/types';

const holds = (group: TaskGroup | null | undefined, taskId: string): group is TaskGroup =>
  Boolean(group?.tasks.some(task => task.id === taskId));

/**
 * The task (all of its runs) the run open in the pane belongs to. It comes
 * from the list page while the task is on it; once paging or a filter takes
 * the task off the page, it is read on its own, and read again each time the
 * list refreshes, so the pane keeps the task's current runs and state.
 */
export function useOpenTaskGroup(taskId: string | null, pageGroups: TaskGroup[]): TaskGroup | null {
  const onPage = taskId ? pageGroups.find(group => holds(group, taskId)) ?? null : null;
  // The last group seen holding the open run, so leaving the page keeps it while it is read again.
  const [held, setHeld] = useState<TaskGroup | null>(onPage);
  if (onPage && held !== onPage) setHeld(onPage);

  useEffect(() => {
    if (!taskId || onPage) return;
    let cancelled = false;
    getTasks({ groupBy: 'task', task: taskId, limit: 1, offset: 0 })
      .then(data => {
        if (cancelled) return;
        const group = groupTasksForDisplay(data.tasks ?? []).find(entry => holds(entry, taskId));
        if (group) setHeld(group);
      })
      .catch(error => {
        // The pane keeps the task it last had; the next list refresh reads it again.
        if (!cancelled) console.error('Error reading the open task:', error);
      });
    return () => {
      cancelled = true;
    };
    // pageGroups changes on every list refresh: that is when the task off the page is read again.
  }, [taskId, onPage, pageGroups]);

  if (!taskId) return null;
  return onPage ?? (holds(held, taskId) ? held : null);
}
