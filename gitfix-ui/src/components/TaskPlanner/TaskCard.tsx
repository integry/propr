import React from 'react';
import { Trash2, Plus } from 'lucide-react';
import { PlanTask } from '../../api/gitfixApi';

interface TaskCardProps {
  task: PlanTask;
  isHighlighted: boolean;
  onChange: (task: PlanTask) => void;
  onDelete: () => void;
  onAddBelow: () => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({ 
  task, 
  isHighlighted, 
  onChange, 
  onDelete,
  onAddBelow 
}) => {
  return (
    <div className={`
      border rounded-lg p-4 mb-4 transition-all duration-500
      ${isHighlighted ? 'bg-yellow-50 border-yellow-300 scale-[1.02] shadow-lg' : 'bg-white border-gray-200 hover:border-gray-300'}
    `}>
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <input 
            className="font-semibold text-lg w-full mb-2 outline-none bg-transparent border-b border-transparent hover:border-gray-200 focus:border-indigo-500 transition-colors px-1"
            value={task.title}
            onChange={e => onChange({ ...task, title: e.target.value })}
            placeholder="Task title"
          />
          <textarea 
            className="w-full text-sm text-gray-600 resize-none outline-none bg-transparent border border-transparent hover:border-gray-200 focus:border-indigo-500 rounded p-2 min-h-[80px] transition-colors"
            value={task.body}
            onChange={e => onChange({ ...task, body: e.target.value })}
            placeholder="Describe the task..."
          />
          
          {task.files.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {task.files.map(f => (
                <span key={f} className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded font-mono">
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>
        
        <div className="flex flex-col gap-1">
          <button
            onClick={onDelete}
            className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
            title="Delete task"
          >
            <Trash2 size={16} />
          </button>
          <button
            onClick={onAddBelow}
            className="p-2 text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 rounded transition-colors"
            title="Add task below"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default TaskCard;
