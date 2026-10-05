import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useTaskSelection } from '../hooks/useTaskSelection';
import { useOpenTaskGroup } from '../hooks/useOpenTaskGroup';
import TaskList from '../components/TaskList';
import TaskDetails from '../components/TaskDetails';
import TaskSplitWorkspace from '../components/TaskList/TaskSplitWorkspace';
import { buildTaskRow, buildTaskRuns, taskPath } from '../components/TaskList/rowModel';
import type { TaskGroup } from '../components/TaskList/types';

/**
 * The list pages by task, one row each with all of its runs, so 25 tasks are 25
 * rows: more than a 1080p pane holds, and the list scrolls above its footer.
 */
const TASKS_PER_PAGE = 25;

/**
 * How often the task page reads its runs again while one of them is queued or
 * running, or while they have not been read yet (the first read failed).
 */
const ROUTE_RUNS_REFRESH_MS = 15_000;

/**
 * Every run of the task a route page shows, oldest first, so the full page has
 * the same timeline of runs as the pane beside the list. The task page has no
 * list to refresh it, so it reads the runs again while one is still in flight,
 * and keeps trying until a first read succeeds.
 */
function useRouteTaskRuns(taskId: string | null) {
  // A new array is what tells the hook to read the task again, as a list refresh does.
  const [refresh, setRefresh] = useState<TaskGroup[]>([]);
  const group = useOpenTaskGroup(taskId, refresh);
  const runs = useMemo(() => (group ? buildTaskRuns(buildTaskRow(group)) : undefined), [group]);
  const live = Boolean(runs?.some(run => run.outcome === 'active' || run.outcome === 'waiting'));
  const polling = Boolean(taskId) && (!runs || live);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => setRefresh([]), ROUTE_RUNS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [taskId, polling]);
  return runs;
}

const TasksPage: React.FC = () => {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { selectedTaskId, select, isSplitViewport } = useTaskSelection();
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const [pageGroups, setPageGroups] = useState<TaskGroup[]>([]);

  // Only set title when viewing task list (TaskDetails sets its own title)
  useDocumentTitle(taskId ? undefined : 'Tasks');

  const closeTask = useCallback(() => select(null), [select]);
  // A delete can finish after the user has moved on to another task, so the
  // pane closes only if the deleted task is still the one selected now.
  const selectedTaskIdRef = useRef(selectedTaskId);
  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);
  const handleDeleted = useCallback((deletedTaskId: string) => {
    if (selectedTaskIdRef.current === deletedTaskId) select(null);
    setListRefreshKey(key => key + 1);
  }, [select]);

  // Wide screens open a task beside the list; narrower ones navigate to it.
  const openTaskId = !taskId && isSplitViewport ? selectedTaskId : null;
  // The task the open run belongs to: its runs are what the pane's timeline
  // lists. It stays with the pane when paging or a filter takes it off the list.
  const openGroup = useOpenTaskGroup(openTaskId, pageGroups);
  // The full page lists the task's runs in its timeline too, and moves between them by route.
  const routeRuns = useRouteTaskRuns(taskId ?? null);
  const openRouteRun = useCallback((runTaskId: string) => navigate(taskPath(runTaskId)), [navigate]);

  // TaskDetails view should not be constrained by parent padding
  if (taskId) {
    // Keyed by run, so moving to another run drops the old run's live subscriptions and state.
    return <TaskDetails key={taskId} runs={routeRuns} onSelectRun={openRouteRun} />;
  }

  return (
    <div className="h-full w-full min-w-0 bg-white">
      <TaskSplitWorkspace
        selectedTaskId={openTaskId}
        selectedGroup={openGroup}
        onSelectRun={select}
        onClose={closeTask}
        onDeleted={handleDeleted}
        list={(
          <TaskList
            limit={TASKS_PER_PAGE}
            selectedTaskId={openTaskId}
            onSelectTask={isSplitViewport ? select : undefined}
            refreshKey={listRefreshKey}
            onGroupsChange={setPageGroups}
          />
        )}
      />
    </div>
  );
};

export default TasksPage;
