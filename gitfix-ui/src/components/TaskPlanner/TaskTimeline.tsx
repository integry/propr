import React from 'react';
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

  return (
    <div
      ref={setNodeRef}
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
        {/* Drag handle */}
        <div
          {...attributes}
          {...listeners}
          className="absolute -left-6 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
        >
          <GripVertical size={14} className="text-gray-400" />
        </div>

        <button
          onClick={() => onStepClick(index)}
          className={`relative flex items-center justify-center w-8 h-8 rounded-full transition-all duration-200 ${
            isDragging
              ? 'bg-indigo-600 text-white shadow-lg scale-110'
              : isActive
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
          <div className="absolute left-full ml-2 px-3 py-1.5 bg-gray-900 text-white text-sm font-medium rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 max-w-[250px] whitespace-normal">
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

export const TaskTimeline: React.FC<TaskTimelineProps> = ({
  taskCount,
  activeIndex,
  onStepClick,
  taskTitles = [],
  taskIds = [],
  completedIndices = [],
  onReorderTasks,
}) => {
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

  if (taskCount === 0) return null;

  // Generate IDs if not provided
  const ids = taskIds.length > 0 ? taskIds : Array.from({ length: taskCount }, (_, i) => `step-${i}`);

  return (
    <div className="sticky top-0 h-full w-16 flex-shrink-0 bg-gray-50 border-r border-gray-200 py-4 overflow-y-auto">
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
            <div className="relative flex flex-col items-center gap-0">
              {ids.map((id, index) => {
                const isActive = index === activeIndex;
                const isCompleted = completedIndices.includes(index);
                const isPast = index < activeIndex;
                const title = taskTitles[index] || `Step ${index + 1}`;

                return (
                  <SortableStep
                    key={id}
                    id={id}
                    index={index}
                    isActive={isActive}
                    isCompleted={isCompleted}
                    isPast={isPast}
                    title={title}
                    onStepClick={onStepClick}
                    isLast={index === taskCount - 1}
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
    </div>
  );
};

export default TaskTimeline;
