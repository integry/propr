import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useTaskSelection } from '../hooks/useTaskSelection';
import TaskList from '../components/TaskList';
import TaskDetails from '../components/TaskDetails';
import TaskSplitWorkspace from '../components/TaskList/TaskSplitWorkspace';
import type { TaskGroup } from '../components/TaskList/types';

/**
 * Runs of one pull request fold into one row, so a page of 50 tasks was often
 * only five to eleven rows and left the list pane half empty beside an open
 * task. 100 tasks fill the pane on a typical page; fewer tasks would mean fewer rows.
 */
const TASKS_PER_PAGE = 100;

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

  // TaskDetails view should not be constrained by parent padding
  if (taskId) {
    return <TaskDetails />;
  }

  // Wide screens open a task beside the list; narrower ones navigate to it.
  const openTaskId = isSplitViewport ? selectedTaskId : null;
  // The row the open run belongs to: its runs are what the pane's run switcher offers.
  const openGroup = openTaskId ? pageGroups.find(group => group.tasks.some(task => task.id === openTaskId)) ?? null : null;
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
