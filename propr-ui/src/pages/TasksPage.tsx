import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useTaskSelection } from '../hooks/useTaskSelection';
import { useOpenTaskGroup } from '../hooks/useOpenTaskGroup';
import TaskList from '../components/TaskList';
import TaskDetails from '../components/TaskDetails';
import TaskSplitWorkspace from '../components/TaskList/TaskSplitWorkspace';
import type { TaskGroup } from '../components/TaskList/types';

/**
 * The list pages by task, one row each with all of its runs, so 25 tasks are 25
 * rows: more than a 1080p pane holds, and the list scrolls above its footer.
 */
const TASKS_PER_PAGE = 25;

const TasksPage: React.FC = () => {
  const { taskId } = useParams();
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

  // TaskDetails view should not be constrained by parent padding
  if (taskId) {
    return <TaskDetails />;
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
