import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Tailwind `xl`: wide enough to show the task list and a task side by side. */
export const TASK_SPLIT_QUERY = '(min-width: 1280px)';

const matchesSplit = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(TASK_SPLIT_QUERY).matches;

export interface TaskSelection {
  /** The task open beside the list, from `?task=`. */
  selectedTaskId: string | null;
  /** Opens a task beside the list, or closes the pane with `null`. Keeps every other query param. */
  select: (taskId: string | null) => void;
  /** Whether the viewport is wide enough for the list and a task side by side. */
  isSplitViewport: boolean;
}

/**
 * The task selected on `/tasks`, kept in the URL so a reload or a shared link
 * restores it with the filters. Selection replaces the history entry, so
 * stepping through tasks with j/k does not fill the back button.
 */
export function useTaskSelection(): TaskSelection {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTaskId = searchParams.get('task') || null;
  // The router applies a URL change inside a transition, so for a moment the
  // URL is ahead of what renders. The latest choice is held here until the
  // URL catches up, so a fast j-j-k steps from where the user really is.
  const [pending, setPending] = useState<{ taskId: string | null } | null>(null);
  const selectedTaskId = pending ? pending.taskId : urlTaskId;
  const [isSplitViewport, setIsSplitViewport] = useState(matchesSplit);

  useEffect(() => {
    if (pending && pending.taskId === urlTaskId) setPending(null);
  }, [pending, urlTaskId]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(TASK_SPLIT_QUERY);
    const update = () => setIsSplitViewport(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const select = useCallback((taskId: string | null) => {
    setPending({ taskId });
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (taskId) next.set('task', taskId);
      else next.delete('task');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  return { selectedTaskId, select, isSplitViewport };
}
