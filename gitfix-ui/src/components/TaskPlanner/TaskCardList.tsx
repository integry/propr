import React, { useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { TaskCard, SortableTaskCard } from './TaskCard';
import TaskTimeline from './TaskTimeline';
import { PlanTask } from '../../api/gitfixApi';

interface TaskCardListProps {
  tasks: PlanTask[];
  highlightedIds: string[];
  onTaskChange: (taskId: string, updates: Partial<PlanTask>) => void;
  onAddTask: (afterTaskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onReorderTasks?: (activeId: string, overId: string) => void;
}

interface HoverAddLineProps {
  isVisible: boolean;
  onAdd: () => void;
}

const HoverAddLine: React.FC<HoverAddLineProps> = ({ isVisible, onAdd }) => {
  return (
    <div
      className={`relative h-6 flex items-center justify-center transition-all duration-200 ${
        isVisible ? 'opacity-100' : 'opacity-0 h-2'
      }`}
    >
      {isVisible && (
        <>
          <div className="absolute left-0 right-0 h-0.5 bg-indigo-300" />
          <button
            onClick={onAdd}
            className="relative z-10 flex items-center justify-center w-6 h-6 bg-indigo-500 text-white rounded-full shadow-md hover:bg-indigo-600 hover:scale-110 transition-all"
          >
            <Plus size={14} />
          </button>
        </>
      )}
    </div>
  );
};

interface HoverZoneProps {
  taskId: string;
  onAddTask: (afterTaskId: string) => void;
}

const HoverZone: React.FC<HoverZoneProps> = ({ taskId, onAddTask }) => {
  const [isHovering, setIsHovering] = useState(false);

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <HoverAddLine isVisible={isHovering} onAdd={() => onAddTask(taskId)} />
    </div>
  );
};

export const TaskCardList: React.FC<TaskCardListProps> = ({
  tasks,
  highlightedIds,
  onTaskChange,
  onAddTask,
  onDeleteTask,
  onReorderTasks,
}) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTaskIndex, setActiveTaskIndex] = useState<number>(0);

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

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id && onReorderTasks) {
      onReorderTasks(active.id as string, over.id as string);
    }

    setActiveId(null);
  };

  const handleDragCancel = () => {
    setActiveId(null);
  };

  const activeTask = activeId ? tasks.find(t => t.id === activeId) : null;

  // Handle scroll-based timeline highlighting
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const cards = container.querySelectorAll('[data-task-index]');

    let closestIndex = 0;
    let closestDistance = Infinity;

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const distance = Math.abs(rect.top - containerRect.top - 100);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = parseInt(card.getAttribute('data-task-index') || '0', 10);
      }
    });

    setActiveTaskIndex(closestIndex);
  }, []);

  const handleTimelineClick = (index: number) => {
    const container = document.querySelector('[data-task-list]');
    const card = container?.querySelector(`[data-task-index="${index}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveTaskIndex(index);
  };

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 p-8">
        <div className="text-center">
          <p className="mb-4">No tasks in the plan yet.</p>
          <button
            onClick={() => onAddTask('')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Plus size={16} />
            Add First Task
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Sticky Timeline Sidebar */}
      <TaskTimeline
        taskCount={tasks.length}
        activeIndex={activeTaskIndex}
        onStepClick={handleTimelineClick}
        taskTitles={tasks.map(t => t.title)}
      />

      {/* Main Task List */}
      <div
        className="flex-1 p-4 overflow-y-auto"
        data-task-list
        onScroll={handleScroll}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={tasks.map(t => t.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2">
              {/* Hover zone before first task */}
              <HoverZone taskId="" onAddTask={() => onAddTask('')} />

              {tasks.map((task, index) => (
                <div key={task.id} data-task-index={index}>
                  <SortableTaskCard
                    task={task}
                    isHighlighted={highlightedIds.includes(task.id)}
                    onChange={(updatedTask) => onTaskChange(task.id, updatedTask)}
                    onDelete={() => onDeleteTask(task.id)}
                    onAddBelow={() => onAddTask(task.id)}
                  />
                  {/* Hover zone after each task */}
                  <HoverZone taskId={task.id} onAddTask={onAddTask} />
                </div>
              ))}
            </div>
          </SortableContext>

          {/* Drag overlay for visual feedback */}
          <DragOverlay>
            {activeTask ? (
              <div className="opacity-90 shadow-2xl">
                <TaskCard
                  task={activeTask}
                  isHighlighted={false}
                  onChange={() => {}}
                  onDelete={() => {}}
                  onAddBelow={() => {}}
                  isDragging
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
};

export default TaskCardList;
