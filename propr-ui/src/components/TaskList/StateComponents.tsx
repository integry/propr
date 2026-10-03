import React, { useMemo } from 'react';
import type { TaskGroup } from './types';
import { TaskQueueRow } from './TaskRows';
import { MobileTaskCard } from './MobileTaskCard';
import { buildTaskRow, TASK_QUEUE_COLUMNS } from './rowModel';
import { ListSkeleton } from '../ui/Skeleton';
import { SystemAlert } from '../ui/SystemAlert';
import './task-queue.css';

/** Renders the first read of the task list as feed rows for dashboard integration */
export const DashboardLoadingState: React.FC = () => (
  <ListSkeleton rows={4} layout="row" label="Loading tasks…" className="p-4" data-testid="tasks-skeleton" />
);

/** Renders the full-page first read as table columns under the real Tasks header */
export const FullPageLoadingState: React.FC = () => (
  <div className="flex flex-col h-full">
    <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
      <h1 className="text-2xl font-bold text-gray-800">Tasks</h1>
    </div>
    <div className="flex-1 overflow-auto px-6 py-6">
      <ListSkeleton rows={8} layout="table" columns={4} label="Loading tasks…" data-testid="tasks-skeleton" />
    </div>
  </div>
);

/** Renders a simple error message for dashboard integration */
export const DashboardErrorState: React.FC<{ error: string }> = ({ error }) => (
  <SystemAlert>Error loading tasks: {error}</SystemAlert>
);

/** Renders a full-page error state with header for the main Tasks page */
export const FullPageErrorState: React.FC<{ error: string }> = ({ error }) => (
  <div className="flex flex-col h-full">
    <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
      <h1 className="text-2xl font-bold text-gray-800">Tasks</h1>
    </div>
    <div className="flex-1 overflow-auto px-6 py-6">
      <SystemAlert>Error loading tasks: {error}</SystemAlert>
    </div>
  </div>
);

interface TaskTableContentProps {
  groupedTasks: TaskGroup[];
  expandedGroups: Set<string>;
  onRowClick: (taskId: string) => void;
  onToggleGroup: (groupKey: string, e: React.MouseEvent) => void;
  /** The task open beside the list; its row is marked selected. */
  selectedTaskId?: string | null;
}

const columnHeader = 'text-[10px] font-bold uppercase tracking-wider text-slate-500';

/**
 * Renders the task ledger: a flat table where the list is wide enough for its fixed
 * metadata columns plus a readable title, and one card per group anywhere narrower.
 */
export const TaskTableContent: React.FC<TaskTableContentProps> = ({
  groupedTasks,
  expandedGroups,
  onRowClick,
  onToggleGroup,
  selectedTaskId,
}) => {
  const rows = useMemo(() => groupedTasks.map(group => ({ group, row: buildTaskRow(group) })), [groupedTasks]);

  return (
    <div className="task-ledger">
      {/* Card View (phones and narrow panes) */}
      <div className="task-queue task-ledger-cards">
        {rows.map(({ group, row }) => (
          <MobileTaskCard
            key={group.key}
            row={row}
            prNumber={group.prNumber}
            expanded={expandedGroups.has(group.key)}
            onRowClick={onRowClick}
            onToggleGroup={onToggleGroup}
            selectedTaskId={selectedTaskId}
          />
        ))}
      </div>

      {/* Ledger */}
      <div role="table" aria-label="Tasks" className="task-queue task-ledger-table">
        <div role="rowgroup" className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50">
          <div role="row" className="task-queue-grid pl-8 pr-6 py-2">
            {TASK_QUEUE_COLUMNS.map((column, index) => (
              <span key={column} role="columnheader" className={`${index > 3 ? 'text-right ' : ''}${columnHeader}`}>{column}</span>
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {rows.map(({ group, row }) => (
            <TaskQueueRow
              key={group.key}
              row={row}
              prNumber={group.prNumber}
              expanded={expandedGroups.has(group.key)}
              onRowClick={onRowClick}
              onToggle={onToggleGroup}
              selectedTaskId={selectedTaskId}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
