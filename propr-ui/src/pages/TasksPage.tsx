import React, { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useTaskSelection } from '../hooks/useTaskSelection';
import TaskList from '../components/TaskList';
import TaskDetails from '../components/TaskDetails';
import TaskSplitWorkspace from '../components/TaskList/TaskSplitWorkspace';

const TasksPage: React.FC = () => {
  const { taskId } = useParams();
  const { selectedTaskId, select, isSplitViewport } = useTaskSelection();
  const [listRefreshKey, setListRefreshKey] = useState(0);

  // Only set title when viewing task list (TaskDetails sets its own title)
  useDocumentTitle(taskId ? undefined : 'Tasks');

  const closeTask = useCallback(() => select(null), [select]);
  const handleDeleted = useCallback(() => {
    select(null);
    setListRefreshKey(key => key + 1);
  }, [select]);

  // TaskDetails view should not be constrained by parent padding
  if (taskId) {
    return <TaskDetails />;
  }

  // Wide screens open a task beside the list; narrower ones navigate to it.
  const openTaskId = isSplitViewport ? selectedTaskId : null;
  return (
    <div className="h-full w-full min-w-0 bg-white">
      <TaskSplitWorkspace
        selectedTaskId={openTaskId}
        onClose={closeTask}
        onDeleted={handleDeleted}
        list={(
          <TaskList
            limit={50}
            selectedTaskId={openTaskId}
            onSelectTask={isSplitViewport ? select : undefined}
            refreshKey={listRefreshKey}
          />
        )}
      />
    </div>
  );
};

export default TasksPage;
