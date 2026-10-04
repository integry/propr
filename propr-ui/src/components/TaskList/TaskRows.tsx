import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, CornerDownRight, Images } from 'lucide-react';
import type { Task } from './types';
import { getStatusPill, getDisplayStatus, formatRelativeTime, formatDuration } from './utils.tsx';
import { ProviderLogo } from '../ui/ProviderLogo';
import { RepositoryChip } from '../ui/RepositoryChip';
import { ReferenceChip } from './ReferenceChips';
import { WorkTypeBadge } from '../Dashboard/sectionPrimitives';
import { getModelDisplayName } from '../../utils/modelDisplay';
import {
  hasRollupLine, pluralize, rowContainsTask, SELECTED_ROW_CLASSES, TASK_RUNS_COLUMN_SPAN, taskPath,
  type TaskRowView, type TaskRunView,
} from './rowModel';

// Prefer catalog labels (including version punctuation), with a readable fallback
// for custom models. The logo already identifies the provider.
const getTaskModelLabel = (model: string, provider: string): string => {
  if (!model) return provider;
  const name = getModelDisplayName(model, { compactAntigravity: true });
  const label = name.replace(/^(?:claude|anthropic|openai|google|opencode|antigravity)[ /-]+/i, '');
  return name === model
    ? label.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase())
    : label;
};

// Keep text selection and nested controls independent of the row click target.
const openRow = (event: React.MouseEvent, taskId: string, onRowClick: (id: string) => void) => {
  if ((event.target as Element).closest('a, button, input, select, textarea, [role="button"]')) return;
  if (window.getSelection()?.toString()) return;
  onRowClick(taskId);
};

/** A plain left click: modified and middle clicks keep the link's own behaviour (new tab, new window). */
const isPlainPrimaryClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

const taskDuration = (task: Task) => formatDuration(task.processedAt || task.createdAt, task.completedAt);

/**
 * The one entity chip a row leads with: the pull request, else the issue, else
 * the task id. A linked issue is named in the chip's tooltip rather than as a
 * second chip, so the title starts at the same place on every row.
 */
export const TaskPrimaryChip: React.FC<{ task: Task; prNumber?: number | null }> = ({ task, prNumber }) => {
  const issue = task.linkedIssueNumber || task.issueNumber;
  if (prNumber) {
    const linked = issue && issue !== prNumber ? ` · Issue #${issue}` : '';
    return <ReferenceChip title={`Pull request #${prNumber}${linked}`}>PR #{prNumber}</ReferenceChip>;
  }
  if (issue) return <ReferenceChip title={`Issue #${issue}`}>Issue #{issue}</ReferenceChip>;
  return <ReferenceChip title={`Task ${task.id}`}>#{task.id.substring(0, 8)}</ReferenceChip>;
};

/**
 * Visual evidence is announced, not drawn: thumbnails in a dense list render as
 * empty wireframes or black boxes until they load, and they break the row height.
 */
export const PreviewCountBadge: React.FC<{ count: number }> = ({ count }) => count > 0 ? (
  <span
    data-testid="preview-count"
    className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-slate-600"
    title={`${pluralize(count, 'published visual preview')} — open the task to view`}
  >
    <Images className="h-3 w-3" aria-hidden="true" />
    {pluralize(count, 'preview')}
  </span>
) : null;

export const TaskAgent: React.FC<{ task: Task }> = ({ task }) => {
  const agent = task.llmProvider || '';
  const model = task.model || task.modelName || '';
  if (!agent && !model) return <span className="text-xs text-slate-300">—</span>;
  const label = getTaskModelLabel(model, agent);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-slate-700" title={[agent, model].filter(Boolean).join(' · ')}>
      <ProviderLogo provider={agent} className="h-3.5 w-3.5 flex-none" />
      <span className="truncate">{label}</span>
    </span>
  );
};

/**
 * Long titles wrap to a second line instead of being cut off mid-word. An
 * unbroken run of characters (a file path, a URL) breaks wherever it has to,
 * so it wraps inside the title column rather than pressing on the columns
 * beside it.
 *
 * The title is a real link to the task page, so Ctrl/Cmd-click, middle-click
 * and "open in new tab" work. A plain click is handed to `onRowClick`, which
 * either opens the task beside the list or navigates to it.
 */
export const TaskTitleLink: React.FC<{
  title: string;
  tooltip: string;
  taskId: string;
  onRowClick: (id: string) => void;
  className?: string;
}> = ({ title, tooltip, taskId, onRowClick, className = 'min-w-0 flex-1' }) => (
  <Link
    to={taskPath(taskId)}
    className={`task-title block text-left text-sm font-medium text-slate-900 ${className}`}
    title={tooltip}
    onClick={event => {
      event.stopPropagation();
      if (!isPlainPrimaryClick(event)) return;
      event.preventDefault();
      if (event.detail > 0 && window.getSelection()?.toString()) return;
      onRowClick(taskId);
    }}
  >
    <span className="line-clamp-2 [overflow-wrap:anywhere]">{title}</span>
  </Link>
);

/** Run statuses worth calling out in the timeline; a finished run says nothing new. */
const QUIET_RUN_STATUSES = new Set(['completed', 'merged']);

/**
 * The line under a title, held to one line: `↳ 6 earlier runs · REVIEW what the
 * newest run did · 2 previews`. The type belongs to the newest run, not the PR,
 * so it travels with that run's summary rather than taking room from the title.
 * A single run with no summary has nothing to put here: its type and previews
 * ride on the title line instead (`TitleLineType`, `TitleLinePreviews`), and this line is not
 * drawn at all.
 */
export const RollupLine: React.FC<{
  row: TaskRowView;
  expanded: boolean;
  runsId: string;
  onToggle: (groupKey: string, e: React.MouseEvent) => void;
}> = ({ row, expanded, runsId, onToggle }) => {
  if (!hasRollupLine(row)) return null;
  const count = row.earlierRuns.length;
  const hasSummary = Boolean(row.type || row.detail);
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-5 text-slate-500">
      {count > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={runsId}
          onClick={event => onToggle(row.key, event)}
          className="task-rollup-toggle inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-sm hover:text-slate-900"
        >
          {/* A fixed box, so the run timeline's rail can start exactly under the caret. */}
          <span aria-hidden="true" className="task-rollup-caret flex h-3 w-3 flex-none items-center justify-center">
            {expanded ? <ChevronDown className="h-3 w-3" strokeWidth={2.5} /> : <CornerDownRight className="h-3 w-3" />}
          </span>
          {expanded ? 'Hide ' : ''}{count} earlier {count === 1 ? 'run' : 'runs'}
        </button>
      )}
      {count > 0 && hasSummary && <span aria-hidden="true" className="flex-none">·</span>}
      {row.type && <span className="flex-none"><WorkTypeBadge type={row.type} /></span>}
      {row.detail && <span className="min-w-0 truncate" title={row.detail}>{row.detail}</span>}
      <PreviewCountBadge count={row.previewCount} />
    </div>
  );
};

/**
 * What a one-line row carries on its title line: the type in front of the
 * title (`[Issue #86]  ✦ IMPLEMENT  Support configuration…`) and the preview
 * count after it. Rows with a rollup line keep both there.
 */
export const TitleLineType: React.FC<{ row: TaskRowView }> = ({ row }) => (
  !hasRollupLine(row) && row.type ? <span className="flex-none"><WorkTypeBadge type={row.type} /></span> : null
);

export const TitleLinePreviews: React.FC<{ row: TaskRowView }> = ({ row }) => (
  hasRollupLine(row) ? null : <PreviewCountBadge count={row.previewCount} />
);

/**
 * The rolled-up runs of one row as a self-contained timeline hanging off the
 * toggle's caret: `when · what it did · summary`. Each run reads as one cluster.
 * Runs share the parent's repository and agent, so they borrow none of its cells.
 */
export const EarlierRunsList: React.FC<{
  id: string;
  runs: TaskRunView[];
  onRowClick: (taskId: string) => void;
  selectedTaskId?: string | null;
}> = ({ id, runs, onRowClick, selectedTaskId }) => (
  <ul id={id} aria-label="Earlier runs" className="task-earlier-runs">
    {runs.map(run => {
      const status = getDisplayStatus(run.task);
      const created = new Date(run.task.createdAt).toLocaleString();
      const selected = run.task.id === selectedTaskId;
      return (
        <li key={run.task.id}>
          <button
            type="button"
            aria-current={selected || undefined}
            onClick={() => onRowClick(run.task.id)}
            className={`${selected ? `${SELECTED_ROW_CLASSES} ` : ''}task-run grid w-full min-w-0 items-center rounded-sm py-0.5 pl-1 text-left text-xs leading-5 text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500`}
          >
            <time dateTime={run.task.createdAt} title={`${created} · took ${taskDuration(run.task)}`} className="whitespace-nowrap font-mono text-[11px] tabular-nums text-slate-500">
              {formatRelativeTime(run.task.createdAt)}
            </time>
            <span className="flex min-w-0 items-center gap-2">
              {/* The slot stays when a run names no action, so every summary starts at the same edge. */}
              <span className="w-20 flex-none">{run.type && <WorkTypeBadge type={run.type} compact />}</span>
              <span className={`task-run-summary min-w-0 truncate ${run.summarized ? 'text-slate-700' : 'text-slate-500'}`} title={run.delta}>{run.delta}</span>
              {!QUIET_RUN_STATUSES.has(status) && <span className="flex-none">{getStatusPill(status)}</span>}
              <PreviewCountBadge count={run.previewCount} />
            </span>
          </button>
        </li>
      );
    })}
  </ul>
);

interface TaskQueueRowProps {
  row: TaskRowView;
  prNumber?: number | null;
  expanded: boolean;
  onRowClick: (taskId: string) => void;
  onToggle: (groupKey: string, e: React.MouseEvent) => void;
  selectedTaskId?: string | null;
}

/** One ledger row: TASK / PR · REPO · STATUS · AGENT · DURATION · UPDATED · SCORE. */
export const TaskQueueRow: React.FC<TaskQueueRowProps> = ({ row, prNumber, expanded, onRowClick, onToggle, selectedTaskId }) => {
  const { task } = row;
  const runsId = `task-runs-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const selected = rowContainsTask(row, selectedTaskId);
  return (
    <div role="presentation" className="border-b border-slate-200" data-testid="task-row">
      <div
        role="row"
        aria-selected={selected}
        className={`task-queue-grid pl-8 pr-6 cursor-pointer py-2 transition-colors ${selected ? SELECTED_ROW_CLASSES : 'hover:bg-slate-50'}`}
        onClick={event => openRow(event, task.id, onRowClick)}
      >
        <div role="cell" className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="flex-none"><TaskPrimaryChip task={task} prNumber={prNumber} /></span>
            <TitleLineType row={row} />
            <TaskTitleLink title={row.title} tooltip={row.fullTitle} taskId={task.id} onRowClick={onRowClick} />
            <TitleLinePreviews row={row} />
          </div>
          <RollupLine row={row} expanded={expanded} runsId={runsId} onToggle={onToggle} />
        </div>
        <div role="cell" className="min-w-0">
          <RepositoryChip repository={row.repository} label={row.repositoryName} />
        </div>
        <div role="cell" className="min-w-0">{getStatusPill(getDisplayStatus(task))}</div>
        <div role="cell" className="min-w-0"><TaskAgent task={task} /></div>
        <div role="cell" className="whitespace-nowrap text-right font-mono text-xs tabular-nums text-slate-700">{taskDuration(task)}</div>
        <div role="cell" className="whitespace-nowrap text-right text-xs tabular-nums text-slate-500">
          <time dateTime={task.createdAt} title={new Date(task.createdAt).toLocaleString()}>{formatRelativeTime(task.createdAt)}</time>
        </div>
      </div>
      {expanded && row.earlierRuns.length > 0 && (
        <div role="row" className="task-queue-grid pl-8 pr-6 pb-2">
          <div role="cell" aria-colspan={TASK_RUNS_COLUMN_SPAN} className="task-runs-cell min-w-0">
            <EarlierRunsList id={runsId} runs={row.earlierRuns} onRowClick={onRowClick} selectedTaskId={selectedTaskId} />
          </div>
        </div>
      )}
    </div>
  );
};
