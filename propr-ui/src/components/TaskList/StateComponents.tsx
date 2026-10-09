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

/**
 * Renders a full-page read as table columns. It fills the body under the Tasks
 * header, which stays mounted so a search or filter keeps its focus while the
 * next scope loads.
 */
export const FullPageLoadingState: React.FC = () => (
  <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
    <ListSkeleton rows={8} layout="table" columns={4} label="Loading tasks…" data-testid="tasks-skeleton" />
  </div>
);

/** Renders a simple error message for dashboard integration */
export const DashboardErrorState: React.FC<{ error: string }> = ({ error }) => (
  <SystemAlert>Error loading tasks: {error}</SystemAlert>
);

/** Renders a full-page error state in the body under the Tasks header */
export const FullPageErrorState: React.FC<{ error: string }> = ({ error }) => (
  <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
    <SystemAlert>Error loading tasks: {error}</SystemAlert>
  </div>
);

interface TaskTableContentProps {
  groupedTasks: TaskGroup[];
  expandedGroups: Set<string>;
  onRowClick: (taskId: string) => void;
  onToggleGroup: (groupKey: string, e: React.MouseEvent) => void;
  /** The task open beside the list; its row is marked selected. */
  selectedTaskId?: string | null;
  /** A row click opens the task beside the list instead of navigating to it. */
  selectsInPlace?: boolean;
}

const columnHeader = 'text-[10px] font-bold uppercase tracking-wider text-slate-500';

/** The times and the score after ASSIGNEES are right-aligned, as their cells are. */
const RIGHT_ALIGNED_FROM = TASK_QUEUE_COLUMNS.indexOf('Assignees');

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
  selectsInPlace = false,
}) => {
  const rows = useMemo(() => groupedTasks.map(group => ({ group, row: buildTaskRow(group) })), [groupedTasks]);

  return (
    <div className="task-ledger">
      {/* Card View (phones and narrow panes) */}
      <div className="task-queue task-ledger-cards pt-1">
        {/*
          The cards have no header row to scroll under, so a card leaving the top would be sliced
          against the toolbar's border. This fade, pinned to the top of the scroll area, lets it go
          out of view softly instead. It takes no space, so the first card starts where it did.
        */}
        <div aria-hidden="true" data-testid="task-cards-top-fade" className="pointer-events-none sticky top-0 z-10 -mb-2 h-2 bg-gradient-to-b from-white to-transparent" />
        {rows.map(({ group, row }) => (
          <MobileTaskCard
            key={group.key}
            row={row}
            prNumber={group.prNumber}
            onRowClick={onRowClick}
            selectedTaskId={selectedTaskId}
            selectsInPlace={selectsInPlace}
          />
        ))}
      </div>

      {/* Ledger */}
      <div role="table" aria-label="Tasks" className="task-queue task-ledger-table">
        <div role="rowgroup" className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50">
          <div role="row" className="task-queue-grid pl-8 pr-6 py-2">
            {TASK_QUEUE_COLUMNS.map((column, index) => (
              <span key={column} role="columnheader" className={`${index > RIGHT_ALIGNED_FROM ? 'text-right ' : ''}${columnHeader}`}>{column}</span>
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
              selectsInPlace={selectsInPlace}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
