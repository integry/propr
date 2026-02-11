import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import TaskCard from './TaskCard';
import TaskTimeline from './TaskTimeline';
import { PlanTask } from '../../api/gitfixApi';

interface TaskCardListProps {
  tasks: PlanTask[];
  highlightedIds: string[];
  onTaskChange: (taskId: string, updates: Partial<PlanTask>) => void;
  onDeleteTask: (taskId: string) => void;
  onReorderTasks?: (activeId: string, overId: string) => void;
}

export const TaskCardList: React.FC<TaskCardListProps> = ({
  tasks,
  highlightedIds,
  onTaskChange,
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
          <p>No tasks in the plan yet.</p>
          <p className="text-sm mt-2">Use the assistant to generate tasks from your prompt.</p>
        </div>
      </div>
    );
  }

  // Only show timeline when there are multiple tasks
  const showTimeline = tasks.length > 1;

  return (
    <div className="flex h-full">
      {/* Sticky Timeline Sidebar with Drag & Drop - only show when multiple tasks */}
      {showTimeline && (
        <TaskTimeline
          taskCount={tasks.length}
          activeIndex={activeTaskIndex}
          onStepClick={handleTimelineClick}
          taskTitles={tasks.map(t => t.title)}
          taskIds={tasks.map(t => t.id)}
          onReorderTasks={onReorderTasks}
        />
      )}

      {/* Main Task List */}
      <div
        className={`flex-1 p-4 overflow-y-auto ${!showTimeline ? 'px-6' : ''}`}
        data-task-list
        onScroll={handleScroll}
      >
        <div className="space-y-4">
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
                    onDelete={() => {
                      // Explicitly capture and log the task.id for debugging
                      const taskIdToDelete = task.id;
                      console.log(`[TaskCardList] Deleting task: id="${taskIdToDelete}", title="${task.title}"`);
                      onDeleteTask(taskIdToDelete);
                    }}
                  />
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
