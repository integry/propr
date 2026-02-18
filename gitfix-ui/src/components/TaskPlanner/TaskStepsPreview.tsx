import React from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2 } from 'lucide-react';

interface Task {
  id: string;
  title: string;
}

interface TaskStepsPreviewProps {
  tasks: Task[];
  activeIndex: number;
  completedIndices: number[];
  timelineRect: DOMRect;
  stepsTop: number;
  onScrollTo: (taskId: string, index: number) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export const TaskStepsPreview: React.FC<TaskStepsPreviewProps> = ({
  tasks,
  activeIndex,
  completedIndices,
  timelineRect,
  stepsTop,
  onScrollTo,
  onMouseEnter,
  onMouseLeave,
}) => {
  if (tasks.length === 0) return null;

  const previewContent = (
    <div
      className="fixed bg-white rounded-lg shadow-xl border border-gray-200 z-[10000] max-h-[80vh] overflow-y-auto"
      style={{
        left: timelineRect.right + 8,
        top: stepsTop,
        minWidth: 280,
        maxWidth: 400,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="py-1">
        {tasks.map((task, index) => {
          const isActive = index === activeIndex;
          const isCompleted = completedIndices.includes(index);
          const isPast = index < activeIndex;

          return (
            <button
              key={task.id}
              onClick={() => onScrollTo(task.id, index)}
              className={`w-full px-3 py-2 flex items-center gap-3 text-left transition-colors hover:bg-gray-50 ${
                isActive ? 'bg-indigo-50' : ''
              }`}
            >
              {/* Step indicator */}
              <div
                className={`flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold ${
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : isCompleted
                    ? 'bg-green-500 text-white'
                    : isPast
                    ? 'bg-indigo-100 text-indigo-600'
                    : 'bg-gray-200 text-gray-500'
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 size={14} />
                ) : (
                  index + 1
                )}
              </div>

              {/* Task title */}
              <span
                className={`flex-1 text-sm truncate ${
                  isActive
                    ? 'text-indigo-700 font-medium'
                    : isCompleted
                    ? 'text-green-700'
                    : isPast
                    ? 'text-indigo-600'
                    : 'text-gray-700'
                }`}
              >
                {task.title || `Step ${index + 1}`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return createPortal(previewContent, document.body);
};

export default TaskStepsPreview;
