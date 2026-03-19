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

  const lineHeight = 16; // h-4 = 16px
  const buttonHeight = 32; // h-8 = 32px

  // Calculate the offset to the center of the button within each step
  const getButtonCenterOffset = (index: number): number => {
    const hasLineAbove = index > 0;
    // Button center is: (line above if any) + half of button height
    return (hasLineAbove ? lineHeight : 0) + buttonHeight / 2;
  };

  // Title row height should match total step height (button + lines)
  const getTitleRowHeight = (index: number, isLast: boolean): number => {
    const hasLineAbove = index > 0;
    const hasLineBelow = !isLast;
    return (hasLineAbove ? lineHeight : 0) + buttonHeight + (hasLineBelow ? lineHeight : 0);
  };

  const previewContent = (
    <div
      className="fixed bg-white border border-slate-200 shadow-xl ring-1 ring-black/5 z-[10000] overflow-hidden rounded-r-lg py-3"
      style={{
        left: timelineRect.right,
        top: stepsTop - 9,
        minWidth: 384,
        maxWidth: 512,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Step titles - aligned with step numbers */}
      <div
        className="max-h-[800px] overflow-y-auto scrollbar-stealth relative"
      >
        {tasks.map((task, index) => {
          const isActive = index === activeIndex;
          const isCompleted = completedIndices.includes(index);
          const isPast = index < activeIndex;
          const isLast = index === tasks.length - 1;
          const stepPos = stepPositions[index];

          // Use measured height if available, otherwise calculate
          const itemHeight = stepPos ? stepPos.height : getTitleRowHeight(index, isLast);

          // Calculate padding to center the text on the button
          // For first item: button is at top, so add padding at top equal to 0
          // For other items: button is after line, so text should be offset by line height
          const buttonCenterOffset = getButtonCenterOffset(index);
          const textHeight = 20; // approximate single line text height
          const paddingTop = buttonCenterOffset - textHeight / 2;
          const paddingBottom = itemHeight - buttonCenterOffset - textHeight / 2;

          return (
            <button
              key={task.id}
              onClick={() => onScrollTo(task.id, index)}
              className={`w-full px-4 flex items-start text-left transition-colors hover:bg-slate-50 ${
                isActive ? 'bg-indigo-50/50' : ''
              }`}
              style={{
                height: `${itemHeight}px`,
                minHeight: '32px',
                paddingTop: `${Math.max(0, paddingTop)}px`,
                paddingBottom: `${Math.max(0, paddingBottom)}px`,
              }}
            >
              {/* Task title - no duplicate step number */}
              <span
                className={`text-sm truncate leading-5 ${
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
