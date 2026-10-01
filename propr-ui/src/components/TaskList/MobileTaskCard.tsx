import React from 'react';
import { ChevronRight } from 'lucide-react';
import { getStatusPill, getDisplayStatus, formatRelativeTime, formatDuration } from './utils.tsx';
import { WorkTypeBadge } from '../Dashboard/sectionPrimitives';
import { EarlierRunsList, PreviewCountBadge, RollupLine, TaskAgent, TaskPrimaryChip, TaskScore } from './TaskRows';
import type { TaskRowView } from './rowModel';

interface MobileTaskCardProps {
  row: TaskRowView;
  prNumber?: number | null;
  expanded: boolean;
  onRowClick: (taskId: string) => void;
  onToggleGroup: (groupKey: string, e: React.MouseEvent) => void;
}

/** The mobile form of a ledger row: the same title, rollup and measures, stacked. */
export const MobileTaskCard: React.FC<MobileTaskCardProps> = ({ row, prNumber, expanded, onRowClick, onToggleGroup }) => {
  const { task } = row;
  const runsId = `task-runs-mobile-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return (
    <div className="border-b border-slate-200 px-4 py-3">
      <div
        onClick={event => {
          if ((event.target as Element).closest('button')) return;
          onRowClick(task.id);
        }}
        className="flex cursor-pointer items-start gap-2 active:bg-slate-50"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex min-w-0 items-center gap-2">
            <TaskPrimaryChip task={task} prNumber={prNumber} />
            {row.type && <WorkTypeBadge type={row.type} compact />}
            <span className="ml-auto flex-none"><TaskScore task={task} /></span>
          </div>
          <p className="line-clamp-2 text-sm font-medium text-slate-900">{row.title}</p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            {getStatusPill(getDisplayStatus(task))}
            <span className="truncate font-mono text-[11px]">{row.repository}</span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span>{formatRelativeTime(task.createdAt)}</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-500">
            <span className="min-w-0"><TaskAgent task={task} /></span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span className="flex-none font-mono">{formatDuration(task.processedAt || task.createdAt, task.completedAt)}</span>
            <PreviewCountBadge count={row.previewCount} />
          </div>
        </div>
        <ChevronRight size={16} className="mt-1 flex-shrink-0 text-slate-400" aria-hidden="true" />
      </div>
      <RollupLine row={row} expanded={expanded} runsId={runsId} onToggle={onToggleGroup} />
      {expanded && row.earlierRuns.length > 0 && (
        <div className="mt-2">
          <EarlierRunsList id={runsId} runs={row.earlierRuns} onRowClick={onRowClick} />
        </div>
      )}
    </div>
  );
};
