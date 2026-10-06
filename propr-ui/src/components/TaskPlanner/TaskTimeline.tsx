import React, { useCallback, useEffect, useRef } from 'react';
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
  onScrollToTask?: (taskId: string, index: number) => void;
}

/**
 * Generated step titles often repeat the plan name with a counter
 * ("Agents v1 (3/17): Agent run store"). The outline already shows the
 * step number, so only the distinguishing part of the title is kept.
 */
const getOutlineTitle = (title: string): string => {
  const stripped = title.replace(/^.*?\(\s*\d+\s*\/\s*\d+\s*\)\s*[:\-–—]\s*/, '').trim();
  return stripped || title.trim();
};

interface OutlineItemProps {
  id: string;
  index: number;
  title: string;
  isActive: boolean;
  isCompleted: boolean;
  canReorder: boolean;
  onSelect: (id: string, index: number) => void;
}

const OutlineItem: React.FC<OutlineItemProps> = ({
  id,
  index,
  title,
  isActive,
  isCompleted,
  canReorder,
  onSelect,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !canReorder });
  const itemRef = useRef<HTMLLIElement | null>(null);

  const combinedRef = useCallback((el: HTMLLIElement | null) => {
    setNodeRef(el);
    itemRef.current = el;
  }, [setNodeRef]);

  // Keep the active entry visible while the specification pane scrolls
  useEffect(() => {
    if (isActive) itemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [isActive]);

  return (
    <li
      ref={combinedRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative flex items-center ${isDragging ? 'z-50 shadow-md bg-white' : ''}`}
    >
      {canReorder && (
        <span
          {...attributes}
          {...listeners}
          aria-label={`Reorder step ${index + 1}`}
          className="absolute left-0 flex h-full w-4 items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
          style={{ touchAction: 'none' }}
        >
          <GripVertical size={12} className="text-slate-400" />
        </span>
      )}
      <button
        type="button"
        onClick={() => onSelect(id, index)}
        aria-current={isActive ? 'step' : undefined}
        title={title}
        className={`flex w-full min-w-0 items-baseline gap-2 border-l-2 py-1.5 pl-4 pr-3 text-left text-[13px] leading-5 transition-colors ${
          isActive
            ? 'border-teal-600 bg-white font-medium text-slate-900'
            : 'border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`}
      >
        <span className={`w-5 flex-shrink-0 text-right font-mono text-xs tabular-nums ${isActive ? 'text-teal-700' : 'text-slate-400'}`}>
          {isCompleted ? <CheckCircle2 size={12} className="inline text-slate-500" /> : `${index + 1}.`}
        </span>
        <span className="min-w-0 line-clamp-2 break-words">{title}</span>
      </button>
    </li>
  );
};

/**
 * Plan outline (table of contents) for the Review step. Every step is listed
 * with its title so engineers can scan and jump without a blocking popover.
 */
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

  const handleSelect = useCallback((taskId: string, index: number) => {
    if (onScrollToTask) {
      onScrollToTask(taskId, index);
    } else {
      onStepClick(index);
    }
  }, [onScrollToTask, onStepClick]);

  if (taskCount === 0) return null;

  // Generate IDs if not provided
  const ids = taskIds.length > 0 ? taskIds : Array.from({ length: taskCount }, (_, i) => `step-${i}`);

  return (
    <nav
      aria-label="Plan outline"
      className="sticky top-0 flex h-full w-72 min-h-0 flex-shrink-0 flex-col border-r border-slate-200 bg-slate-50"
    >
      <div className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Plan Outline</span>
        <span className="text-xs tabular-nums text-slate-400">
          <span className="font-medium text-slate-600">{activeIndex + 1}</span> / {taskCount}
        </span>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={ids}
          strategy={verticalListSortingStrategy}
        >
          <ol className="min-h-0 flex-1 overflow-y-auto pb-4 scrollbar-thin">
            {ids.map((id, index) => (
              <OutlineItem
                key={id}
                id={id}
                index={index}
                title={getOutlineTitle(taskTitles[index] || `Step ${index + 1}`)}
                isActive={index === activeIndex}
                isCompleted={completedIndices.includes(index)}
                canReorder={!!onReorderTasks}
                onSelect={handleSelect}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </nav>
  );
};

export default TaskTimeline;
