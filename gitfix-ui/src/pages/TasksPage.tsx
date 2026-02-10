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
    <div className="p-4 sm:p-8">
      {taskId ? (
        <TaskDetails />
      ) : (
        <>
          <h2 className="text-gray-900 text-2xl font-semibold mb-4">Tasks</h2>
          <p className="text-gray-600 mb-4">View all current and previous tasks.</p>
          <TaskList limit={50} />
        </>
      )}
    </div>
  );
};

export default TasksPage;