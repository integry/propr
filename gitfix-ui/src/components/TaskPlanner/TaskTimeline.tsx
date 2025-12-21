import React from 'react';
import { CheckCircle2 } from 'lucide-react';

interface TaskTimelineProps {
  taskCount: number;
  activeIndex: number;
  onStepClick: (index: number) => void;
  taskTitles?: string[];
  completedIndices?: number[];
}

export const TaskTimeline: React.FC<TaskTimelineProps> = ({
  taskCount,
  activeIndex,
  onStepClick,
  taskTitles = [],
  completedIndices = [],
}) => {
  if (taskCount === 0) return null;

  return (
    <div className="sticky top-0 h-full w-16 flex-shrink-0 bg-gray-50 border-r border-gray-200 py-4 overflow-y-auto">
      <div className="flex flex-col items-center">
        {/* Timeline header */}
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Steps
        </div>

        {/* Timeline steps */}
        <div className="relative flex flex-col items-center gap-0">
          {Array.from({ length: taskCount }).map((_, index) => {
            const isActive = index === activeIndex;
            const isCompleted = completedIndices.includes(index);
            const isPast = index < activeIndex;
            const title = taskTitles[index] || `Step ${index + 1}`;

            return (
              <div key={index} className="relative flex flex-col items-center">
                {/* Connecting line (above) */}
                {index > 0 && (
                  <div
                    className={`w-0.5 h-4 ${
                      isPast || isActive ? 'bg-indigo-400' : 'bg-gray-300'
                    }`}
                  />
                )}

                {/* Step indicator */}
                <button
                  onClick={() => onStepClick(index)}
                  className={`group relative flex items-center justify-center w-8 h-8 rounded-full transition-all duration-200 ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-md scale-110'
                      : isCompleted
                      ? 'bg-green-500 text-white'
                      : isPast
                      ? 'bg-indigo-200 text-indigo-600'
                      : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
                  }`}
                  title={title}
                >
                  {isCompleted ? (
                    <CheckCircle2 size={16} />
                  ) : (
                    <span className="text-xs font-semibold">{index + 1}</span>
                  )}

                  {/* Tooltip on hover */}
                  <div className="absolute left-full ml-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 max-w-[150px] truncate">
                    {title}
                  </div>
                </button>

                {/* Connecting line (below) */}
                {index < taskCount - 1 && (
                  <div
                    className={`w-0.5 h-4 ${
                      isPast ? 'bg-indigo-400' : 'bg-gray-300'
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Progress indicator */}
        <div className="mt-4 text-xs text-gray-500">
          <span className="font-medium text-indigo-600">{activeIndex + 1}</span>
          <span> / {taskCount}</span>
        </div>
      </div>
    </div>
  );
};

export default TaskTimeline;
