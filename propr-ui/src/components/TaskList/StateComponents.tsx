import React, { useMemo } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { TaskGroup } from './types';
import { TaskQueueRow } from './TaskRows';
import { MobileTaskCard } from './MobileTaskCard';
import { buildTaskRow, TASK_QUEUE_COLUMNS } from './rowModel';
import { SystemAlert } from '../ui/SystemAlert';
import './task-queue.css';

/** Renders a simple loading message for dashboard integration */
export const DashboardLoadingState: React.FC = () => (
  <div role="status" className="flex items-center gap-2 p-4 text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Loading tasks...</div>
);

/** Renders a full-page loading state with header for the main Tasks page */
export const FullPageLoadingState: React.FC = () => (
  <div className="flex flex-col h-full">
    <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
      <h1 className="text-2xl font-bold text-gray-800">Tasks</h1>
    </div>
    <div className="flex-1 overflow-auto px-6 py-6">
      <div role="status" className="flex items-center gap-2 text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Loading tasks...</div>
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
}

const columnHeader = 'text-[10px] font-bold uppercase tracking-wider text-slate-500';

/** Renders the task ledger: a flat table on desktop, one card per group on mobile. */
export const TaskTableContent: React.FC<TaskTableContentProps> = ({
  groupedTasks,
  expandedGroups,
  onRowClick,
  onToggleGroup,
}) => {
  const rows = useMemo(() => groupedTasks.map(group => ({ group, row: buildTaskRow(group) })), [groupedTasks]);

  return (
    <>
      {/* Mobile Card View */}
      <div className="task-queue md:hidden">
        {rows.map(({ group, row }) => (
          <MobileTaskCard
            key={group.key}
            row={row}
            prNumber={group.prNumber}
            expanded={expandedGroups.has(group.key)}
            onRowClick={onRowClick}
            onToggleGroup={onToggleGroup}
          />
        ))}
      </div>

      {/* Desktop Ledger */}
      <div role="table" aria-label="Tasks" className="task-queue hidden md:block">
        <div role="rowgroup" className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50">
          <div role="row" className="task-queue-grid px-4 py-2 sm:px-6">
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
            />
          ))}
        </div>
      </div>
    </>
  );
};
