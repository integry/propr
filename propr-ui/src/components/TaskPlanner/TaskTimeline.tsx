import React, { useCallback, useEffect, useRef } from 'react';
import { CheckCircle2, GripVertical, PanelLeftClose } from 'lucide-react';
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
import { getOutlineTitle } from './planDisplayName';

interface TaskTimelineProps {
  taskCount: number;
  activeIndex: number;
  onStepClick: (index: number) => void;
  taskTitles?: string[];
  taskIds?: string[];
  completedIndices?: number[];
  onReorderTasks?: (activeId: string, overId: string) => void;
  onScrollToTask?: (taskId: string, index: number) => void;
  onCollapse?: () => void;
}

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

  // Keep the active entry visible while the specification pane scrolls. Only the outline list
  // scrolls: scrollIntoView would also scroll every ancestor and shift the page layout.
  useEffect(() => {
    const item = itemRef.current;
    const list = item?.parentElement;
    if (!isActive || !item || !list) return;
    const itemRect = item.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop += itemRect.top - listRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
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
          // Inset past the 2px active border so the handle sits inside the row, left of the step number.
          className="absolute left-1.5 z-10 flex h-full w-4 items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
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
        className={`flex w-full min-w-0 items-baseline gap-2 border-l-2 py-1.5 ${canReorder ? 'pl-6' : 'pl-4'} pr-3 text-left text-[13px] leading-5 transition-colors ${
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
  onCollapse,
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
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Plan Outline</span>
        <span className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-slate-400">
            <span className="font-medium text-slate-600">{activeIndex + 1}</span> / {taskCount}
          </span>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Collapse outline"
              title="Collapse outline"
              className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition-colors"
            >
              <PanelLeftClose size={14} />
            </button>
          )}
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
