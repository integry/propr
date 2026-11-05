import React from 'react';
import { GripVertical, PanelLeftOpen } from 'lucide-react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getOutlineTitle, getTabLabel } from './planDisplayName';

/** Plans with fewer steps than this navigate with a tab bar instead of the outline rail. */
export const OUTLINE_RAIL_MIN_TASKS = 5;

interface TaskTabBarProps {
  taskTitles: string[];
  taskIds: string[];
  activeIndex: number;
  onSelect: (taskId: string, index: number) => void;
  /** Reorders the plan, as the outline rail does for longer plans. */
  onReorderTasks?: (activeId: string, overId: string) => void;
}

interface StepTabProps {
  id: string;
  index: number;
  fullTitle: string;
  isActive: boolean;
  canReorder: boolean;
  onSelect: (taskId: string, index: number) => void;
}

const StepTab: React.FC<StepTabProps> = ({ id, index, fullTitle, isActive, canReorder, onSelect }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !canReorder });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group relative min-w-[5rem] flex-initial ${isDragging ? 'z-20 bg-white shadow-md' : ''}`}
    >
      {canReorder && (
        <span
          {...attributes}
          {...listeners}
          aria-label={`Reorder step ${index + 1}`}
          className="absolute left-0.5 top-0 z-10 flex h-full w-3.5 items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 cursor-grab active:cursor-grabbing"
          style={{ touchAction: 'none' }}
        >
          <GripVertical size={12} className="text-slate-400" />
        </span>
      )}
      <button
        type="button"
        onClick={() => onSelect(id, index)}
        aria-current={isActive ? 'step' : undefined}
        title={getOutlineTitle(fullTitle)}
        className={`-mb-px flex h-full w-full min-w-0 items-baseline gap-1.5 whitespace-nowrap border-b-2 ${canReorder ? 'pl-4' : 'pl-3'} pr-3 py-2 text-left text-[13px] leading-snug transition-colors ${
          isActive
            ? 'border-teal-600 font-medium text-slate-900'
            : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
        }`}
      >
        <span className={`flex-shrink-0 font-mono text-xs tabular-nums ${isActive ? 'text-teal-700' : 'text-slate-400'}`}>{index + 1}.</span>
        {/* Tabs index the plan with a short feature label; the full title is in the tooltip and the specification. */}
        <span className="truncate">{getTabLabel(fullTitle)}</span>
      </button>
    </li>
  );
};

/**
 * Horizontal step navigation for short plans. A 2–4 step outline would leave
 * the rail mostly empty, so the steps sit above the specification instead and
 * the specification keeps the full reading width. Steps drag to reorder, like the rail.
 */
export const TaskTabBar: React.FC<TaskTabBarProps> = ({ taskTitles, taskIds, activeIndex, onSelect, onReorderTasks }) => {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id && onReorderTasks) onReorderTasks(String(active.id), String(over.id));
  };

  return (
    // A fixed row above the specification's scroll container (not sticky inside it), so
    // specification content can never render above or through the tabs.
    <nav aria-label="Plan steps" className="relative z-10 flex-shrink-0 border-b border-slate-200 bg-white px-6">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={taskIds} strategy={horizontalListSortingStrategy}>
          <ol className="flex min-w-0 gap-1 overflow-x-auto scrollbar-thin">
            {taskIds.map((id, index) => (
              <StepTab
                key={id}
                id={id}
                index={index}
                fullTitle={taskTitles[index] || `Step ${index + 1}`}
                isActive={index === activeIndex}
                canReorder={!!onReorderTasks}
                onSelect={onSelect}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </nav>
  );
};

/** The outline rail once collapsed: a narrow strip that only offers to reopen it. */
export const CollapsedOutlineRail: React.FC<{ activeIndex: number; taskCount: number; onExpand: () => void }> = ({
  activeIndex,
  taskCount,
  onExpand,
}) => (
  <div className="flex w-10 flex-shrink-0 flex-col items-center gap-2 border-r border-slate-200 bg-slate-50 pt-3">
    <button
      type="button"
      onClick={onExpand}
      aria-label="Show outline"
      title="Show outline"
      className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
    >
      <PanelLeftOpen size={16} />
    </button>
    <span className="text-[11px] tabular-nums text-slate-400 [writing-mode:vertical-rl]">
      {activeIndex + 1} / {taskCount}
    </span>
  </div>
);
