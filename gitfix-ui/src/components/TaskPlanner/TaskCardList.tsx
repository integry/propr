import React, { useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import TaskCard from './TaskCard';
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
  const [activeTaskIndex, setActiveTaskIndex] = useState<number>(0);

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
      {/* Sticky Timeline Sidebar with Drag & Drop */}
      <TaskTimeline
        taskCount={tasks.length}
        activeIndex={activeTaskIndex}
        onStepClick={handleTimelineClick}
        taskTitles={tasks.map(t => t.title)}
        taskIds={tasks.map(t => t.id)}
        onReorderTasks={onReorderTasks}
      />

      {/* Main Task List */}
      <div
        className="flex-1 p-4 overflow-y-auto"
        data-task-list
        onScroll={handleScroll}
      >
        <div className="space-y-2">
          {/* Hover zone before first task */}
          <HoverZone taskId="" onAddTask={() => onAddTask('')} />

          <AnimatePresence mode="popLayout">
            {tasks.map((task, index) => {
              const isHighlighted = highlightedIds.includes(task.id);
              return (
                <motion.div
                  key={task.id}
                  data-task-index={index}
                  layout
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    scale: 1,
                    boxShadow: isHighlighted
                      ? '0 0 0 3px rgba(129, 140, 248, 0.4), 0 4px 20px rgba(129, 140, 248, 0.15)'
                      : 'none',
                  }}
                  exit={{ opacity: 0, scale: 0.95, y: -10 }}
                  transition={{
                    layout: { duration: 0.3 },
                    opacity: { duration: 0.2 },
                    scale: { duration: 0.2 },
                    boxShadow: { duration: 0.3 },
                  }}
                  className="relative"
                >
                  {/* Highlight pulse effect */}
                  {isHighlighted && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: [0.5, 0.2, 0.5] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                      className="absolute inset-0 bg-indigo-100 rounded-xl -z-10"
                    />
                  )}
                  <TaskCard
                    task={task}
                    isHighlighted={isHighlighted}
                    stepNumber={index + 1}
                    onChange={(updatedTask) => onTaskChange(task.id, updatedTask)}
                    onDelete={() => onDeleteTask(task.id)}
                    onAddBelow={() => onAddTask(task.id)}
                  />
                  {/* Hover zone after each task */}
                  <HoverZone taskId={task.id} onAddTask={onAddTask} />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default TaskCardList;
