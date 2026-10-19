import React from 'react';
import { getStatusPill, getDisplayStatus, formatRelativeTime, formatDuration } from './utils.tsx';
import { PreviewCountBadge, RunCountChip, TaskAgent, TaskPrimaryChip, TaskTitleLink } from './TaskRows';
import { WorkTypeBadge } from '../Dashboard/sectionPrimitives';
import { AssigneeList } from '../AssigneeList';
import type { Task } from './types';
import { rowContainsTask, SELECTED_ROW_CLASSES, type TaskRowView } from './rowModel';

interface MobileTaskCardProps {
  row: TaskRowView;
  prNumber?: number | null;
  onRowClick: (taskId: string) => void;
  selectedTaskId?: string | null;
  /**
   * The card selects its task in place, beside the list, where the list is
   * for scanning and the title holds to one line. Anywhere else the title may
   * take two lines, since a phone cuts most titles short of telling tasks apart.
   */
  selectsInPlace?: boolean;
}

/** The repository name is never cut shorter than this. */
const REPOSITORY_MIN_CHARS = 10;

/** A chip stands 22px tall but takes a 20px line, so a first line that fits keeps the height it always had. */
const CHIP_SLOT = 'flex h-5 flex-none items-center';

const taskDuration = (task: Task) => formatDuration(task.processedAt || task.createdAt, task.completedAt);

/**
 * The card form of a ledger row, for a phone or the list beside an open task.
 * The list is for scanning, so the card holds to three lines and leaves the
 * rest to the task itself:
 *
 *   [PR #2664] [🖼 2]  propr  ● Implementing           1 min ago (1m 00s)
 *   Stop work when an issue or PR withdraws intent
 *   [+4] ●─■─■─⟳  GPT-6 Astra  ⚡ ULTRAFIX  ◉ @octocat  Ultrafix cycle 3 (linting)
 *
 * Attachments ride beside the entity chip, where they always land in the same
 * place, and the age and run time share one cluster on the right. A phone
 * keeps only the age there; the task itself shows the run time.
 *
 * The repository name keeps its first ten characters however tight the line
 * gets, so a short name such as `propr` is never cut to `pr…`.
 *
 * Where the chips, ten characters of repository, status and age cannot share
 * one line (a 320px phone with `PR #46 [🖼 12]` and `Cancelled`), the first
 * line wraps rather than scrolling sideways: the age, then the status if need
 * be, drops beneath, still holding the right edge, and the repository takes
 * the room they leave. With room, the repository grows only to its own width,
 * so the status sits right after it as always.
 *
 * The assignees follow the type: avatars alone on a phone, with their logins
 * anywhere wider. An unassigned task shows nothing there, since the card has
 * no column for a dash to hold.
 *
 * The third line's summary is the one part that gives way. A phone drops it,
 * and anywhere else it shows only with room for a readable stretch of it
 * (about 7rem): with less, it wraps onto a second line that the one-line box
 * clips, rather than ending in a letter or two and `…`.
 *
 * The lines sit 6px apart, so the bold title is not pressed against the
 * chips above it or the run track below it.
 *
 * The card never opens its runs in place. Seven runs listed under one card
 * would take most of a phone's screen, and a caret is too small to tap
 * safely. The run track only shows the trend; tapping the card opens the
 * task, whose timeline holds every run.
 *
 * There is no trailing drill-in chevron: the title is the link to the task.
 *
 * The divider between cards is light and inset to the content's edges, so
 * the list does not read as a stack of ruled bars.
 */
export const MobileTaskCard: React.FC<MobileTaskCardProps> = ({ row, prNumber, onRowClick, selectedTaskId, selectsInPlace = false }) => {
  const { task } = row;
  const selected = rowContainsTask(row, selectedTaskId);
  const summary = row.detail ?? row.outcome;
  const repositoryMin = `${Math.min(row.repositoryName.length, REPOSITORY_MIN_CHARS)}ch`;
  return (
    <div
      data-testid="task-card"
      aria-current={selected || undefined}
      onClick={event => {
        if ((event.target as Element).closest('a, button')) return;
        onRowClick(task.id);
      }}
      className={`cursor-pointer px-4 ${selected ? SELECTED_ROW_CLASSES : 'active:bg-slate-50'}`}
    >
      <div data-testid="task-card-body" className="border-b border-slate-100 py-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div data-testid="task-card-heading" className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            <span data-testid="task-card-entity" className={CHIP_SLOT}><TaskPrimaryChip task={task} prNumber={prNumber} /></span>
            {row.previewCount > 0 && <span className={CHIP_SLOT}><PreviewCountBadge count={row.previewCount} compact /></span>}
            <span data-testid="task-card-repository" className="max-w-max grow truncate font-mono text-[11px]" style={{ minWidth: repositoryMin, flexBasis: repositoryMin }} title={row.repository}>{row.repositoryName}</span>
            <span data-testid="task-card-status" className={CHIP_SLOT}>{getStatusPill(getDisplayStatus(task), row.type)}</span>
            <span data-testid="task-card-age" className="ml-auto flex-none whitespace-nowrap pl-2 tabular-nums" title={`Started ${new Date(task.createdAt).toLocaleString()}`}>
              <time dateTime={task.createdAt}>{formatRelativeTime(task.createdAt)}</time>
              <span className="ml-1 font-mono text-[11px] text-slate-400 max-sm:hidden" title="Run time">({taskDuration(task)})</span>
            </span>
          </div>
          <TaskTitleLink title={row.title} tooltip={row.fullTitle} taskId={task.id} onRowClick={onRowClick} selected={selected} singleLine={selectsInPlace} className="min-w-0" />
          <div data-testid="task-card-meta" className="flex h-5 min-w-0 flex-wrap content-start items-center gap-x-3 overflow-hidden text-xs leading-5 text-slate-500">
            {row.earlierRuns.length > 0 && <RunCountChip row={row} />}
            <span className="flex min-w-0 max-w-[40%] flex-none"><TaskAgent task={task} /></span>
            {row.type && <span className="flex-none"><WorkTypeBadge type={row.type} /></span>}
            {row.assignees.length > 0 && (
              <span data-testid="task-card-assignees" className="flex flex-none items-center">
                <AssigneeList assignees={row.assignees} variant="compact" className="flex-nowrap" />
              </span>
            )}
            {summary && <span data-testid="task-card-summary" className="min-w-[7rem] flex-1 truncate max-sm:hidden" title={summary}>{summary}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};
