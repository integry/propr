import React, { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import TaskCard from './TaskCard';
import TaskTimeline from './TaskTimeline';
import { CollapsedOutlineRail, OUTLINE_RAIL_MIN_TASKS, TaskTabBar } from './TaskTabBar';
import { MobileTaskJumper } from './MobileTaskJumper';
import { PlanTask } from '../../api/proprApi';
import { useIsMobile } from '../../hooks/useIsMobile';

interface TaskCardListProps {
  tasks: PlanTask[];
  highlightedIds: string[];
  draftId: string;
  onTaskChange: (taskId: string, updates: Partial<PlanTask>) => void;
  onDeleteTask: (taskId: string) => void;
  onReorderTasks?: (activeId: string, overId: string) => void;
  hideNotes?: boolean;
}

export const TaskCardList: React.FC<TaskCardListProps> = ({
  tasks,
  highlightedIds,
  draftId,
  onTaskChange,
  onDeleteTask,
  onReorderTasks,
  hideNotes = false,
}) => {
  const isMobile = useIsMobile();
  const [activeTaskIndex, setActiveTaskIndex] = useState<number>(0);
  const [isOutlineCollapsed, setIsOutlineCollapsed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll-spy: the specification is one continuous document, so the active step follows
  // the scroll position. A step is active once its heading passes the reading line near the
  // top of the pane; at the very bottom the last step wins even if it is too short to get there.
  const syncActiveTaskFromScroll = useCallback((container: HTMLElement) => {
    const cards = Array.from(container.querySelectorAll('[data-task-index]'));
    if (cards.length === 0) return;
    const containerRect = container.getBoundingClientRect();
    const readingLine = containerRect.top + Math.min(120, containerRect.height / 3);
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;

    let activeIndex = 0;
    if (atBottom && container.scrollTop > 0) {
      activeIndex = cards.length - 1;
    } else {
      cards.forEach((card, index) => {
        if (card.getBoundingClientRect().top <= readingLine) activeIndex = index;
      });
    }
    setActiveTaskIndex(parseInt(cards[activeIndex].getAttribute('data-task-index') || '0', 10));
  }, []);

  // While a tab or outline click scrolls the specification, the clicked step stays active
  // instead of flickering through the steps the smooth scroll passes. If the user scrolled
  // elsewhere during the lock, the active step is recomputed once the lock expires.
  const clickScrollLockRef = useRef<number | null>(null);
  const clickScrollTargetRef = useRef<number | null>(null);
  const lockScrollSpy = useCallback((ms: number) => {
    if (clickScrollLockRef.current !== null) window.clearTimeout(clickScrollLockRef.current);
    clickScrollLockRef.current = window.setTimeout(() => {
      clickScrollLockRef.current = null;
      const container = listRef.current;
      const target = clickScrollTargetRef.current;
      clickScrollTargetRef.current = null;
      if (!container || target === null) return;
      const reachableTop = Math.max(0, Math.min(target, container.scrollHeight - container.clientHeight));
      if (Math.abs(container.scrollTop - reachableTop) > 2) syncActiveTaskFromScroll(container);
    }, ms);
  }, [syncActiveTaskFromScroll]);
  useEffect(() => () => {
    if (clickScrollLockRef.current !== null) window.clearTimeout(clickScrollLockRef.current);
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (clickScrollLockRef.current !== null) {
      lockScrollSpy(150);
      return;
    }
    syncActiveTaskFromScroll(e.currentTarget);
  }, [lockScrollSpy, syncActiveTaskFromScroll]);

  // Scroll only the specification container. scrollIntoView would also scroll every
  // ancestor (including overflow-hidden ones), shifting the tab bar out of place.
  const scrollTaskIntoView = (card: Element | null | undefined) => {
    const container = listRef.current;
    if (!container || !card) return;
    const top = container.scrollTop + card.getBoundingClientRect().top - container.getBoundingClientRect().top;
    clickScrollTargetRef.current = top;
    lockScrollSpy(1000);
    container.scrollTo({ top, behavior: 'smooth' });
  };

  const handleTimelineClick = (index: number) => {
    scrollTaskIntoView(listRef.current?.querySelector(`[data-task-index="${index}"]`));
    setActiveTaskIndex(index);
  };

  const handleScrollToTask = (taskId: string, index: number) => {
    const taskCard = document.getElementById(`task-card-${taskId}`);
    if (taskCard) {
      scrollTaskIntoView(taskCard);
      setActiveTaskIndex(index);
    } else {
      handleTimelineClick(index);
    }
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

  // Multi-step plans get navigation on desktop: a tab bar for short plans,
  // a collapsible outline rail once the plan is long enough to need one.
  // Phones get a "Task N of M" jumper instead.
  const showMobileJumper = tasks.length > 1 && isMobile;
  const showNavigation = tasks.length > 1 && !isMobile;
  const showOutlineRail = showNavigation && tasks.length >= OUTLINE_RAIL_MIN_TASKS;
  const showTabBar = showNavigation && !showOutlineRail;
  const taskTitles = tasks.map(t => t.title);
  const taskIds = tasks.map(t => t.id);

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {showOutlineRail && !isOutlineCollapsed && (
        <TaskTimeline
          taskCount={tasks.length}
          activeIndex={activeTaskIndex}
          onStepClick={handleTimelineClick}
          taskTitles={taskTitles}
          taskIds={taskIds}
          onReorderTasks={onReorderTasks}
          onScrollToTask={handleScrollToTask}
          onCollapse={() => setIsOutlineCollapsed(true)}
        />
      )}
      {showOutlineRail && isOutlineCollapsed && (
        <CollapsedOutlineRail
          activeIndex={activeTaskIndex}
          taskCount={tasks.length}
          onExpand={() => setIsOutlineCollapsed(false)}
        />
      )}

      {/* The tab bar sits above the scroll container, never inside it, so content cannot scroll above it. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {showMobileJumper && (
          <MobileTaskJumper taskTitles={taskTitles} activeIndex={activeTaskIndex} onSelect={handleTimelineClick} />
        )}
        {showTabBar && (
          <TaskTabBar
            taskTitles={taskTitles}
            taskIds={taskIds}
            activeIndex={activeTaskIndex}
            onSelect={handleScrollToTask}
            onReorderTasks={onReorderTasks}
          />
        )}

        {/* Main Task List */}
        <div
          className={`task-list-scroll relative isolate min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] ${isMobile ? 'p-3' : 'p-4'} ${!showOutlineRail && !isMobile ? 'px-6' : ''}`}
          ref={listRef}
          data-task-list
          onScroll={handleScroll}
          style={{
            scrollbarWidth: 'thin',
            scrollbarColor: '#d1d5db transparent'
          }}
        >
          <style>{`
            .task-list-scroll::-webkit-scrollbar {
              width: 6px;
            }
            .task-list-scroll::-webkit-scrollbar-track {
              background: transparent;
            }
            .task-list-scroll::-webkit-scrollbar-thumb {
              background-color: #d1d5db;
              border-radius: 3px;
            }
          `}</style>
          <div className="pb-4">
            <AnimatePresence mode="popLayout">
              {tasks.map((task, index) => {
                const isHighlighted = highlightedIds.includes(task.id);
                const isLastTask = index === tasks.length - 1;
                return (
                  <motion.div
                    key={task.id}
                    data-task-index={index}
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    animate={{
                      opacity: 1,
                      y: 0,
                    }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{
                      layout: { duration: 0.3 },
                      opacity: { duration: 0.2 },
                    }}
                    className="relative"
                  >
                    {/* Highlight pulse effect */}
                    {isHighlighted && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: [0.3, 0.1, 0.3] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                        className="absolute inset-0 bg-indigo-50 rounded-lg -z-10"
                      />
                    )}
                    <TaskCard
                      task={task}
                      isHighlighted={isHighlighted}
                      stepNumber={index + 1}
                      draftId={draftId}
                      hideNotes={hideNotes}
                      onChange={(updatedTask) => onTaskChange(task.id, updatedTask)}
                      onDelete={() => {
                        // Explicitly capture and log the task.id for debugging
                        const taskIdToDelete = task.id;
                        console.log(`[TaskCardList] Deleting task: id="${taskIdToDelete}", title="${task.title}"`);
                        onDeleteTask(taskIdToDelete);
                      }}
                      id={`task-card-${task.id}`}
                    />
                    {/* Horizontal divider between tasks */}
                    {!isLastTask && (
                      <div className="my-8 border-b border-gray-200" />
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskCardList;
