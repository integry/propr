import React, { useState, useRef, useCallback } from 'react';
import { CheckCircle2, GripVertical } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskStepsPreview } from './TaskStepsPreview';

interface TaskTimelineProps {
  taskCount: number;
  activeIndex: number;
  onStepClick: (index: number) => void;
  taskTitles?: string[];
  taskIds?: string[];
  completedIndices?: number[];
  onReorderTasks?: (activeId: string, overId: string) => void;
  onScrollToTask?: (taskId: string, index: number) => void;
}

interface SortableStepProps {
  id: string;
  index: number;
  isActive: boolean;
  isCompleted: boolean;
  isPast: boolean;
  onStepClick: (index: number) => void;
  isLast: boolean;
  stepRef?: (el: HTMLDivElement | null) => void;
}

const SortableStep: React.FC<SortableStepProps> = ({
  id,
  index,
  isActive,
  isCompleted,
  isPast,
  onStepClick,
  isLast,
  stepRef,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Combine refs
  const combinedRef = useCallback((el: HTMLDivElement | null) => {
    setNodeRef(el);
    if (stepRef) stepRef(el);
  }, [setNodeRef, stepRef]);

  return (
    <div
      ref={combinedRef}
      style={style}
      className={`relative flex flex-col items-center ${isDragging ? 'z-50' : ''}`}
    >
      {/* Connecting line (above) */}
      {index > 0 && (
        <div
          className={`w-0.5 h-4 ${
            isPast || isActive ? 'bg-indigo-400' : 'bg-gray-300'
          }`}
        />
      )}

      {/* Step indicator with drag handle */}
      <div className="group relative flex items-center">
        {/* Drag handle - positioned to be fully visible and draggable */}
        <div
          {...attributes}
          {...listeners}
          className="absolute -left-6 w-5 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing z-20"
          style={{ touchAction: 'none' }}
        >
          <GripVertical size={14} className="text-gray-400 hover:text-gray-600" />
        </div>

        <button
          onClick={() => onStepClick(index)}
          className={`relative flex items-center justify-center w-8 h-8 rounded-full transition-all duration-200 ${
            isDragging
              ? 'bg-indigo-600 text-white shadow-lg scale-110'
              : isActive
              ? 'bg-indigo-600 text-white shadow-md ring-2 ring-indigo-300 ring-offset-2'
              : isCompleted
              ? 'bg-green-500 text-white'
              : isPast
              ? 'bg-indigo-100 text-indigo-500'
              : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
          }`}
        >
          {isCompleted ? (
            <CheckCircle2 size={16} />
          ) : (
            <span className="text-xs font-semibold">{index + 1}</span>
          )}
        </button>
      </div>

      {/* Connecting line (below) */}
      {!isLast && (
        <div
          className={`w-0.5 h-4 ${
            isPast ? 'bg-indigo-400' : 'bg-gray-300'
          }`}
        />
      )}
    </div>
  );
};

interface StepPosition {
  top: number;
  height: number;
}

export const TaskTimeline: React.FC<TaskTimelineProps> = ({
  taskCount,
  activeIndex,
  onStepClick,
  taskTitles = [],
  taskIds = [],
  completedIndices = [],
  onReorderTasks,
  onScrollToTask,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [timelineRect, setTimelineRect] = useState<DOMRect | null>(null);
  const [stepsTop, setStepsTop] = useState<number>(0);
  const [stepPositions, setStepPositions] = useState<StepPosition[]>([]);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stepsContainerRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id && onReorderTasks) {
      onReorderTasks(active.id as string, over.id as string);
    }
  };

  const handleMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (timelineRef.current) {
      setTimelineRect(timelineRef.current.getBoundingClientRect());
    }
    if (stepsContainerRef.current) {
      const containerRect = stepsContainerRef.current.getBoundingClientRect();
      setStepsTop(containerRect.top);

      // Calculate positions for each step relative to container
      const positions: StepPosition[] = stepRefs.current.map((ref) => {
        if (ref) {
          const rect = ref.getBoundingClientRect();
          return {
            top: rect.top - containerRect.top,
            height: rect.height,
          };
        }
        return { top: 0, height: 40 };
      });
      setStepPositions(positions);
    }
    setIsHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
      setTimelineRect(null);
    }, 150);
  }, []);

  const handlePreviewMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  const handlePreviewMouseLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
      setTimelineRect(null);
    }, 150);
  }, []);

  const handleScrollTo = useCallback((taskId: string, index: number) => {
    if (onScrollToTask) {
      onScrollToTask(taskId, index);
    } else {
      onStepClick(index);
    }
    setIsHovered(false);
    setTimelineRect(null);
  }, [onScrollToTask, onStepClick]);

  if (taskCount === 0) return null;

  // Generate IDs if not provided
  const ids = taskIds.length > 0 ? taskIds : Array.from({ length: taskCount }, (_, i) => `step-${i}`);

  // Build tasks array for preview
  const tasks = ids.map((id, index) => ({
    id,
    title: taskTitles[index] || `Step ${index + 1}`,
  }));

  return (
    <div
      ref={timelineRef}
      className="sticky top-0 h-full w-24 flex-shrink-0 bg-gray-50 border-r border-gray-200 py-4 pl-4 overflow-y-auto min-h-0 scrollbar-thin"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex flex-col items-center">
        {/* Timeline header */}
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Steps
        </div>

        {/* Timeline steps with Drag & Drop */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={ids}
            strategy={verticalListSortingStrategy}
          >
            <div ref={stepsContainerRef} className="relative flex flex-col items-center gap-0">
              {ids.map((id, index) => {
                const isActive = index === activeIndex;
                const isCompleted = completedIndices.includes(index);
                const isPast = index < activeIndex;

                return (
                  <SortableStep
                    key={id}
                    id={id}
                    index={index}
                    isActive={isActive}
                    isCompleted={isCompleted}
                    isPast={isPast}
                    onStepClick={onStepClick}
                    isLast={index === taskCount - 1}
                    stepRef={(el) => {
                      stepRefs.current[index] = el;
                    }}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>

        {/* Progress indicator */}
        <div className="mt-4 text-xs text-gray-500">
          <span className="font-medium text-indigo-600">{activeIndex + 1}</span>
          <span> / {taskCount}</span>
        </div>
      </div>

      {/* Task Steps Preview Portal */}
      {isHovered && timelineRect && (
        <TaskStepsPreview
          tasks={tasks}
          activeIndex={activeIndex}
          completedIndices={completedIndices}
          timelineRect={timelineRect}
          stepsTop={stepsTop}
          stepPositions={stepPositions}
          onScrollTo={handleScrollTo}
          onMouseEnter={handlePreviewMouseEnter}
          onMouseLeave={handlePreviewMouseLeave}
        />
      )}
    </div>
  );
};

export default TaskTimeline;
