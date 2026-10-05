import React from 'react';
import { getStatusPill, getDisplayStatus, formatRelativeTime, formatDuration } from './utils.tsx';
import { EarlierRunsList, PreviewCountBadge, RunCountChip, TaskAgent, TaskPrimaryChip, TaskTitleLink } from './TaskRows';
import { WorkTypeBadge } from '../Dashboard/sectionPrimitives';
import type { Task } from './types';
import { rowContainsTask, SELECTED_ROW_CLASSES, type TaskRowView } from './rowModel';

interface MobileTaskCardProps {
  row: TaskRowView;
  prNumber?: number | null;
  expanded: boolean;
  onRowClick: (taskId: string) => void;
  onToggleGroup: (groupKey: string, e: React.MouseEvent) => void;
  selectedTaskId?: string | null;
  /**
   * The card selects its task in place, beside the list. Its runs are then
   * reached through the pane's timeline, so the card shows their trend and
   * lists none.
   */
  selectsInPlace?: boolean;
}

/** The repository name is never cut shorter than this. */
const REPOSITORY_MIN_CHARS = 10;

const taskDuration = (task: Task) => formatDuration(task.processedAt || task.createdAt, task.completedAt);

/**
 * The card form of a ledger row, for a phone or the list beside an open task.
 * The list is for scanning, so the card holds to three lines and leaves the
 * rest to the task itself:
 *
 *   [PR #2664] [🖼 2]  propr  ● Implementing           1 min ago (1m 00s)
 *   Stop work when an issue or PR withdraws intent
 *   [+4] ●─■─■─⟳  GPT-6 Astra  ⚡ ULTRAFIX  Ultrafix cycle 3 (linting)
 *
 * Attachments ride beside the entity chip, where they always land in the same
 * place, and the age and run time share one cluster on the right. A phone
 * keeps only the age there; the task itself shows the run time.
 *
 * The repository name keeps its first ten characters however tight the line
 * gets, so a short name such as `propr` is never cut to `pr…`.
 *
 * The third line's summary is the one part that gives way. A phone drops it,
 * and anywhere else it shows only with room for a readable stretch of it
 * (about 7rem): with less, it wraps onto a second line that the one-line box
 * clips, rather than ending in a letter or two and `…`.
 *
 * There is no trailing drill-in chevron: the title is the link to the task,
 * and the only chevron on the card is the run track's, which opens its runs
 * in place.
 */
export const MobileTaskCard: React.FC<MobileTaskCardProps> = ({ row, prNumber, expanded, onRowClick, onToggleGroup, selectedTaskId, selectsInPlace = false }) => {
  const { task } = row;
  const runsId = `task-runs-mobile-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const selected = rowContainsTask(row, selectedTaskId);
  const summary = row.detail ?? row.outcome;
  const hasAgent = Boolean(task.llmProvider || task.model || task.modelName);
  return (
    <div
      data-testid="task-card"
      aria-current={selected || undefined}
      className={`border-b border-slate-200 px-4 py-1.5${selected ? ` ${SELECTED_ROW_CLASSES}` : ''}`}
    >
      <div
        onClick={event => {
          if ((event.target as Element).closest('a, button')) return;
          onRowClick(task.id);
        }}
        className="flex cursor-pointer items-center gap-2 active:bg-slate-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex h-5 min-w-0 items-center gap-2 text-xs text-slate-500">
            <span className="flex-none"><TaskPrimaryChip task={task} prNumber={prNumber} /></span>
            <PreviewCountBadge count={row.previewCount} compact />
            <span className="min-w-0 truncate font-mono text-[11px]" style={{ minWidth: `${Math.min(row.repositoryName.length, REPOSITORY_MIN_CHARS)}ch` }} title={row.repository}>{row.repositoryName}</span>
            <span className="flex-none">{getStatusPill(getDisplayStatus(task))}</span>
            <span className="ml-auto flex-none whitespace-nowrap pl-2 tabular-nums" title={`Started ${new Date(task.createdAt).toLocaleString()}`}>
              <time dateTime={task.createdAt}>{formatRelativeTime(task.createdAt)}</time>
              <span className="ml-1 font-mono text-[11px] text-slate-400 max-sm:hidden" title="Run time">({taskDuration(task)})</span>
            </span>
          </div>
          <TaskTitleLink title={row.title} tooltip={row.fullTitle} taskId={task.id} onRowClick={onRowClick} selected={selected} singleLine className="min-w-0" />
          <div data-testid="task-card-meta" className="flex h-5 min-w-0 flex-wrap content-start items-center gap-x-3 overflow-hidden text-xs leading-5 text-slate-500">
            {row.earlierRuns.length > 0 && <RunCountChip row={row} expanded={expanded} runsId={runsId} onToggle={onToggleGroup} selectsInPlace={selectsInPlace} />}
            {hasAgent && <span className="flex min-w-0 max-w-[40%] flex-none"><TaskAgent task={task} /></span>}
            {row.type && <span className="flex-none"><WorkTypeBadge type={row.type} /></span>}
            {summary && <span data-testid="task-card-summary" className="min-w-[7rem] flex-1 truncate max-sm:hidden" title={summary}>{summary}</span>}
          </div>
        </div>
      </div>
      {!selectsInPlace && expanded && row.earlierRuns.length > 0 && (
        <div className="mt-2">
          <EarlierRunsList id={runsId} runs={row.earlierRuns} onRowClick={onRowClick} selectedTaskId={selectedTaskId} />
        </div>
      )}
    </div>
  );
};
