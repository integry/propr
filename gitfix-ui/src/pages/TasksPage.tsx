import React from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import TaskList from '../components/TaskList';
import TaskDetails from '../components/TaskDetails';

const TasksPage: React.FC = () => {
  const { taskId } = useParams();

  // Only set title when viewing task list (TaskDetails sets its own title)
  useDocumentTitle(taskId ? undefined : 'Tasks');

  return (
    <div className={taskId ? 'p-4 sm:p-8' : ''}>
      {taskId ? (
        <TaskDetails />
      ) : (
        <TaskList limit={50} title="Tasks" />
      )}
    </div>
  );
};

export default TasksPage;