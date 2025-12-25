import React, { useState } from 'react';
import { CheckCircle2, GripVertical } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface TaskTimelineProps {
  taskCount: number;
  activeIndex: number;
  onStepClick: (index: number) => void;
  taskTitles?: string[];
  taskIds?: string[];
  completedIndices?: number[];
  onReorderTasks?: (activeId: string, overId: string) => void;
}

interface SortableStepProps {
  id: string;
  index: number;
  isActive: boolean;
  isCompleted: boolean;
  isPast: boolean;
  title: string;
  onStepClick: (index: number) => void;
  isLast: boolean;
  isBeingDragged: boolean;
}

const SortableStep: React.FC<SortableStepProps> = ({
  id,
  index,
  isActive,
  isCompleted,
  isPast,
  title,
  onStepClick,
  isLast,
  isBeingDragged,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || undefined,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative flex flex-col items-center"
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
        {/* Drag handle - inline next to step circle */}
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="mr-1 w-4 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing focus:outline-none"
          style={{ touchAction: 'none' }}
          tabIndex={0}
        >
          <GripVertical size={12} className="text-gray-400 hover:text-gray-600" />
        </button>

        <button
          onClick={() => onStepClick(index)}
          className={`relative flex items-center justify-center w-8 h-8 rounded-full transition-all duration-200 ${
            isBeingDragged
              ? 'bg-indigo-600 text-white shadow-lg scale-110'
              : isActive
              ? 'bg-indigo-600 text-white shadow-md ring-2 ring-indigo-300 ring-offset-2'
              : isCompleted
              ? 'bg-green-500 text-white'
              : isPast
              ? 'bg-indigo-100 text-indigo-500'
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
          <div className="absolute left-full ml-3 px-3 py-1.5 bg-gray-900 text-white text-sm font-medium rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none max-w-[250px] whitespace-normal" style={{ zIndex: 9999 }}>
            {title}
          </div>
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

// Component to render the step circle during drag overlay
interface DragOverlayStepProps {
  index: number;
  isActive: boolean;
  isCompleted: boolean;
  isPast: boolean;
  title: string;
}

const DragOverlayStep: React.FC<DragOverlayStepProps> = ({
  index,
  isActive,
  isCompleted,
  isPast,
  title,
}) => {
  return (
    <div className="flex items-center bg-white rounded-lg shadow-xl p-2 border-2 border-indigo-400">
      <div className="mr-2 w-4 h-8 flex items-center justify-center cursor-grabbing">
        <GripVertical size={12} className="text-gray-600" />
      </div>
      <div
        className={`flex items-center justify-center w-8 h-8 rounded-full ${
          isActive
            ? 'bg-indigo-600 text-white'
            : isCompleted
            ? 'bg-green-500 text-white'
            : isPast
            ? 'bg-indigo-100 text-indigo-500'
            : 'bg-gray-200 text-gray-500'
        }`}
      >
        {isCompleted ? (
          <CheckCircle2 size={16} />
        ) : (
          <span className="text-xs font-semibold">{index + 1}</span>
        )}
      </div>
      <span className="ml-2 text-sm font-medium text-gray-700 max-w-[150px] truncate">
        {title}
      </span>
    </div>
  );
};

export const TaskTimeline: React.FC<TaskTimelineProps> = ({
  taskCount,
  activeIndex,
  onStepClick,
  taskTitles = [],
  taskIds = [],
  completedIndices = [],
  onReorderTasks,
}) => {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    setActiveId(null);

    if (over && active.id !== over.id && onReorderTasks) {
      onReorderTasks(active.id as string, over.id as string);
    }
  };

  if (taskCount === 0) return null;

  // Generate IDs if not provided
  const ids = taskIds.length > 0 ? taskIds : Array.from({ length: taskCount }, (_, i) => `step-${i}`);

  // Find active item details for drag overlay
  const activeIndex_ = activeId ? ids.indexOf(activeId) : -1;
  const activeTitle = activeIndex_ >= 0 ? (taskTitles[activeIndex_] || `Step ${activeIndex_ + 1}`) : '';
  const activeIsActive = activeIndex_ === activeIndex;
  const activeIsCompleted = activeIndex_ >= 0 && completedIndices.includes(activeIndex_);
  const activeIsPast = activeIndex_ < activeIndex;

  return (
    <div className="sticky top-0 h-full w-28 flex-shrink-0 bg-gray-50 border-r border-gray-200 py-4 px-2">
      <div className="flex flex-col items-center">
        {/* Timeline header */}
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Steps
        </div>

        {/* Timeline steps with Drag & Drop */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={ids}
            strategy={verticalListSortingStrategy}
          >
            <div className="relative flex flex-col items-center gap-0">
              {ids.map((id, index) => {
                const isActiveStep = index === activeIndex;
                const isCompleted = completedIndices.includes(index);
                const isPast = index < activeIndex;
                const title = taskTitles[index] || `Step ${index + 1}`;
                const isBeingDragged = activeId === id;

                return (
                  <SortableStep
                    key={id}
                    id={id}
                    index={index}
                    isActive={isActiveStep}
                    isCompleted={isCompleted}
                    isPast={isPast}
                    title={title}
                    onStepClick={onStepClick}
                    isLast={index === taskCount - 1}
                    isBeingDragged={isBeingDragged}
                  />
                );
              })}
            </div>
          </SortableContext>

          {/* Drag overlay for visual feedback */}
          <DragOverlay dropAnimation={null}>
            {activeId && activeIndex_ >= 0 ? (
              <DragOverlayStep
                index={activeIndex_}
                isActive={activeIsActive}
                isCompleted={activeIsCompleted}
                isPast={activeIsPast}
                title={activeTitle}
              />
            ) : null}
          </DragOverlay>
        </DndContext>

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
