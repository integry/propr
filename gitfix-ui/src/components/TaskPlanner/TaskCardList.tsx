import React from 'react';
import { Plus } from 'lucide-react';
import TaskCard from './TaskCard';
import { PlanTask } from '../../api/gitfixApi';

interface TaskCardListProps {
  tasks: PlanTask[];
  highlightedIds: string[];
  onTaskChange: (taskId: string, updates: Partial<PlanTask>) => void;
  onAddTask: (afterTaskId: string) => void;
  onDeleteTask: (taskId: string) => void;
}

export const TaskCardList: React.FC<TaskCardListProps> = ({
  tasks,
  highlightedIds,
  onTaskChange,
  onAddTask,
  onDeleteTask
}) => {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 p-8">
        <div className="text-center">
          <p className="mb-4">No tasks in the plan yet.</p>
          <button
            onClick={() => onAddTask('')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Plus size={16} />
            Add First Task
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 overflow-y-auto h-full">
      <div className="space-y-2">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            isHighlighted={highlightedIds.includes(task.id)}
            onChange={(updatedTask) => onTaskChange(task.id, updatedTask)}
            onDelete={() => onDeleteTask(task.id)}
            onAddBelow={() => onAddTask(task.id)}
          />
        ))}
      </div>
      <button
        onClick={() => onAddTask(tasks[tasks.length - 1]?.id || '')}
        className="mt-4 w-full p-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-indigo-400 hover:text-indigo-600 transition-colors flex items-center justify-center gap-2"
      >
        <Plus size={18} />
        Add Task
      </button>
    </div>
  );
};

export default TaskCardList;
