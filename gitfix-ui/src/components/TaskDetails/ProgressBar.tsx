import React from 'react';
import { TodoItem } from './types';

interface ProgressBarProps {
  todos: TodoItem[];
}

const ProgressBar: React.FC<ProgressBarProps> = ({ todos }) => {
  if (todos.length === 0) {
    return null;
  }

  const completedCount = todos.filter(t => t.status === 'completed').length;
  const progressPercent = Math.round((completedCount / todos.length) * 100);

  return (
    <div className="w-full h-1 bg-gray-200">
      <div
        className="h-full bg-green-500 transition-all duration-300 ease-out"
        style={{ width: `${progressPercent}%` }}
      />
    </div>
  );
};

export default ProgressBar;
