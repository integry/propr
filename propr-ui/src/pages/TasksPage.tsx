import React from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import TaskList from '../components/TaskList';
import TaskDetails from '../components/TaskDetails';

const TasksPage: React.FC = () => {
  const { taskId } = useParams();

  // Only set title when viewing task list (TaskDetails sets its own title)
  useDocumentTitle(taskId ? undefined : 'Tasks');

  // TaskDetails view should not be constrained by parent padding
  if (taskId) {
    return <TaskDetails />;
  }

  // Full-height flex column layout for TaskList with anchored header/footer
  return (
    <div className="flex flex-col h-full">
      <TaskList limit={50} />
    </div>
  );
};

export default TasksPage;