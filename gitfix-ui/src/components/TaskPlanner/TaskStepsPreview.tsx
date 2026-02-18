import React from 'react';
import { createPortal } from 'react-dom';

interface Task {
  id: string;
  title: string;
}

interface StepPosition {
  top: number;
  height: number;
}

interface TaskStepsPreviewProps {
  tasks: Task[];
  activeIndex: number;
  completedIndices: number[];
  timelineRect: DOMRect;
  stepsTop: number;
  stepPositions: StepPosition[];
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
  stepPositions,
  onScrollTo,
  onMouseEnter,
  onMouseLeave,
}) => {
  if (tasks.length === 0) return null;

  const previewContent = (
    <div
      className="fixed bg-white border border-slate-200 shadow-xl ring-1 ring-black/5 z-[10000] overflow-hidden"
      style={{
        left: timelineRect.right,
        top: stepsTop,
        minWidth: 280,
        maxWidth: 400,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Step titles - aligned with step numbers */}
      <div className="max-h-[600px] overflow-y-auto scrollbar-stealth">
        {tasks.map((task, index) => {
          const isActive = index === activeIndex;
          const isCompleted = completedIndices.includes(index);
          const isPast = index < activeIndex;
          const stepPos = stepPositions[index];

          // Calculate the height to match the step item height in the navigation
          const itemHeight = stepPos ? stepPos.height : 40;

          return (
            <button
              key={task.id}
              onClick={() => onScrollTo(task.id, index)}
              className={`w-full px-4 flex items-center text-left transition-colors hover:bg-slate-50 border-b border-slate-50 ${
                isActive ? 'bg-indigo-50/50' : ''
              }`}
              style={{
                height: `${itemHeight}px`,
                minHeight: '40px',
              }}
            >
              {/* Task title - no duplicate step number */}
              <span
                className={`text-sm truncate ${
                  isActive
                    ? 'text-slate-900 font-medium'
                    : isCompleted
                    ? 'text-green-700'
                    : isPast
                    ? 'text-slate-700'
                    : 'text-slate-600'
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
