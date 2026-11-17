import React from 'react';

/**
 * Stands in for the task's title until it arrives: a grey bar the height of
 * one title line, never the literal text "Loading...". Screen readers hear
 * that the title is loading.
 */
const TaskTitleSkeleton: React.FC = () => (
  <>
    <span
      aria-hidden="true"
      data-testid="task-title-skeleton"
      className="block h-[1.25em] w-2/3 max-w-md rounded-sm bg-slate-100 animate-pulse motion-reduce:animate-none"
    />
    <span className="sr-only">Loading task title</span>
  </>
);

export default TaskTitleSkeleton;
