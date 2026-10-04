import React from 'react';
import { ChevronRight } from 'lucide-react';
import { getStatusPill, getDisplayStatus, formatRelativeTime, formatDuration } from './utils.tsx';
import { EarlierRunsList, RollupLine, TaskAgent, TaskPrimaryChip, TaskTitleLink, TitleLinePreviews, TitleLineType } from './TaskRows';
import { rowContainsTask, SELECTED_ROW_CLASSES, type TaskRowView } from './rowModel';

interface MobileTaskCardProps {
  row: TaskRowView;
  prNumber?: number | null;
  expanded: boolean;
  onRowClick: (taskId: string) => void;
  onToggleGroup: (groupKey: string, e: React.MouseEvent) => void;
  selectedTaskId?: string | null;
  /**
   * The card selects its task in place, beside the list. The trailing chevron
   * promises a drill-in to another screen, so it is drawn only when the card
   * navigates. Its runs are then reached through the pane's timeline, so the
   * card shows their trend and lists none.
   */
  selectsInPlace?: boolean;
}

/** The mobile form of a ledger row: the same title, rollup and measures, stacked. */
export const MobileTaskCard: React.FC<MobileTaskCardProps> = ({ row, prNumber, expanded, onRowClick, onToggleGroup, selectedTaskId, selectsInPlace = false }) => {
  const { task } = row;
  const runsId = `task-runs-mobile-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const selected = rowContainsTask(row, selectedTaskId);
  return (
    <div
      data-testid="task-card"
      aria-current={selected || undefined}
      className={`border-b border-slate-200 px-4 py-3${selected ? ` ${SELECTED_ROW_CLASSES}` : ''}`}
    >
      <div
        onClick={event => {
          if ((event.target as Element).closest('a, button')) return;
          onRowClick(task.id);
        }}
        className="flex cursor-pointer items-start gap-2 active:bg-slate-50"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex min-w-0 items-center gap-2">
            <TaskPrimaryChip task={task} prNumber={prNumber} />
            <TitleLineType row={row} />
            <TitleLinePreviews row={row} />
          </div>
          <TaskTitleLink title={row.title} tooltip={row.fullTitle} taskId={task.id} onRowClick={onRowClick} selected={selected} className="min-w-0" />
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            {getStatusPill(getDisplayStatus(task))}
            <span className="truncate font-mono text-[11px]" title={row.repository}>{row.repositoryName}</span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span>{formatRelativeTime(task.createdAt)}</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-500">
            <span className="min-w-0"><TaskAgent task={task} /></span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span className="flex-none font-mono">{formatDuration(task.processedAt || task.createdAt, task.completedAt)}</span>
          </div>
        </div>
        {!selectsInPlace && <ChevronRight size={16} className="mt-1 flex-shrink-0 text-slate-400" aria-hidden="true" />}
      </div>
      <RollupLine row={row} expanded={expanded} runsId={runsId} onToggle={onToggleGroup} selectsInPlace={selectsInPlace} />
      {!selectsInPlace && expanded && row.earlierRuns.length > 0 && (
        <div className="mt-2">
          <EarlierRunsList id={runsId} runs={row.earlierRuns} onRowClick={onRowClick} selectedTaskId={selectedTaskId} />
        </div>
      )}
    </div>
  );
};
