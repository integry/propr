import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Images } from 'lucide-react';
import type { Task } from './types';
import { getStatusPill, getDisplayStatus, formatRelativeTime, formatDuration } from './utils.tsx';
import { ProviderLogo } from '../ui/ProviderLogo';
import { ReferenceChip } from './ReferenceChips';
import { WorkTypeBadge } from '../Dashboard/sectionPrimitives';
import { getModelDisplayName } from '../../utils/modelDisplay';
import { RunTrack } from './RunTrack';
import { ScoreBadge } from './ScoreBadge';
import { AssigneeStack } from '../AssigneeList';
import {
  buildTaskRuns, describeRun, pluralize, RUN_TRACK_LIMIT, rowContainsTask, rowScore, runScore, SELECTED_ROW_CLASSES, TASK_RUNS_COLUMN_SPAN, taskPath,
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
export const PreviewCountBadge: React.FC<{
  count: number;
  /** `[🖼 2]`: the noun is left to the tooltip and screen readers, so the chip fits beside the entity chip. */
  compact?: boolean;
}> = ({ count, compact = false }) => count > 0 ? (
  <span
    data-testid="preview-count"
    className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-slate-600"
    title={`${pluralize(count, 'published visual preview')} — open the task to view`}
  >
    <Images className="h-3 w-3" aria-hidden="true" />
    {compact
      ? <>{count}<span className="sr-only">{count === 1 ? ' preview' : ' previews'}</span></>
      : pluralize(count, 'preview')}
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
 * Unless held to one line, long titles wrap to a second line instead of being cut off mid-word. An
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
  /** The task open beside the list: the title stays dark and gains weight instead of looking like a link. */
  selected?: boolean;
  /** Hold the title to one line, ending in `…`, where the row is a scanning card rather than a ledger row. */
  singleLine?: boolean;
  className?: string;
}> = ({ title, tooltip, taskId, onRowClick, selected = false, singleLine = false, className = 'min-w-0 flex-1' }) => (
  <Link
    to={taskPath(taskId)}
    aria-current={selected || undefined}
    className={`task-title block text-left text-sm ${selected ? 'font-semibold' : 'font-medium'} text-slate-900 ${className}`}
    title={tooltip}
    onClick={event => {
      event.stopPropagation();
      if (!isPlainPrimaryClick(event)) return;
      event.preventDefault();
      if (event.detail > 0 && window.getSelection()?.toString()) return;
      onRowClick(taskId);
    }}
  >
    <span className={singleLine ? 'block truncate' : 'line-clamp-2 [overflow-wrap:anywhere]'}>{title}</span>
  </Link>
);

/**
 * The ledger's REPO cell: the name as plain monospace text. The column is the
 * container, so a chip around it only stacks identical bubbles down the list;
 * chips are for entities named inline among other text.
 */
export const TaskRepository: React.FC<{ row: TaskRowView }> = ({ row }) => (
  <span data-testid="task-repository" title={row.repository} className="block truncate font-mono text-xs text-slate-600 transition-colors hover:text-slate-900">
    {row.repositoryName}
  </span>
);

/**
 * The ledger's ASSIGNEES cell: overlapping avatars, capped with a `+N`, so the
 * cell stays one avatar tall however many people the task is assigned to; an
 * unassigned task shows the em dash.
 */
export const TaskAssignees: React.FC<{ row: TaskRowView }> = ({ row }) => (
  <span data-testid="task-assignees" className="flex min-w-0 items-center">
    <AssigneeStack assignees={row.assignees} variant="compact" />
  </span>
);

/** The ledger's SCORE cell: the task's newest review score, or a dash when no review scored it. */
export const TaskScore: React.FC<{ row: TaskRowView }> = ({ row }) => {
  const score = rowScore(row);
  return score == null
    ? <span className="text-xs text-slate-300" aria-label="No score">—</span>
    : <ScoreBadge score={score} bracketed className="!w-auto !min-w-0 !max-w-none" label="Review score" />;
};

/** Run statuses worth calling out in the timeline; a finished run says nothing new. */
const QUIET_RUN_STATUSES = new Set(['completed', 'merged']);

/** The chip's look; the toggle form adds only hover and focus states. */
const RUN_CHIP_CLASSES = 'inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-slate-600';

/**
 * The task's runs as a bounded trend: `[+4] ●──■──■──⟳`, the newest four runs
 * marked by outcome. The row is the task, so its runs are summarized rather
 * than listed under it. Where the task opens beside the list, the pane's
 * timeline moves between them and the track only shows the trend, as it does
 * on a card, which never opens its runs in place. Where a ledger row's click
 * leaves the list instead, the track is the one way to reach an earlier run,
 * so it opens them in place.
 */
export const RunCountChip: React.FC<{
  row: TaskRowView;
  /** Given, the track is a toggle that opens the runs under the row; omitted, it only shows the trend. */
  toggle?: {
    expanded: boolean;
    runsId: string;
    onToggle: (groupKey: string, e: React.MouseEvent) => void;
  };
}> = ({ row, toggle }) => {
  const runs = buildTaskRuns(row);
  const label = pluralize(runs.length, 'run');
  const description = `${label}: ${runs.slice(-RUN_TRACK_LIMIT).map(describeRun).join(', ')}`;
  if (!toggle) {
    return (
      <span data-testid="run-count" role="img" aria-label={label} title={description} className="inline-flex flex-none items-center">
        <RunTrack runs={runs} />
      </span>
    );
  }
  const { expanded, runsId, onToggle } = toggle;
  return (
    <button
      type="button"
      data-testid="run-count"
      aria-label={label}
      title={description}
      aria-expanded={expanded}
      aria-controls={runsId}
      onClick={event => onToggle(row.key, event)}
      className={`task-rollup-toggle ${RUN_CHIP_CLASSES} hover:border-slate-300 hover:text-slate-900`}
    >
      {/* A fixed box, so the run timeline's rail can start exactly under the caret. */}
      <span aria-hidden="true" className="task-rollup-caret flex h-3 w-3 flex-none items-center justify-center">
        <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? '' : '-rotate-90'}`} strokeWidth={2.5} />
      </span>
      <RunTrack runs={runs} />
    </button>
  );
};

/**
 * The line under a title, held to one line: `[+3] ●──■──■──⟳  REVIEW what the newest
 * run did · 2 previews`. The type belongs to the newest run, not the task, so
 * it travels with that run's summary rather than taking room from the title.
 * A newest run with no summary states its outcome in the same place (why it
 * failed, the commit it pushed), as the run timeline does, so no line ends on
 * a bare type. Every row draws it, single run or not, so every row is the
 * same two lines: `[chip] title` over `[type] what happened`.
 */
export const RollupLine: React.FC<{
  row: TaskRowView;
  expanded: boolean;
  runsId: string;
  onToggle: (groupKey: string, e: React.MouseEvent) => void;
  selectsInPlace?: boolean;
}> = ({ row, expanded, runsId, onToggle, selectsInPlace = false }) => {
  const hasRuns = row.earlierRuns.length > 0;
  const summary = row.detail ?? row.outcome;
  return (
    <div className="mt-0.5 flex h-5 min-w-0 items-center gap-1.5 text-xs leading-5 text-slate-500">
      {hasRuns && <RunCountChip row={row} toggle={selectsInPlace ? undefined : { expanded, runsId, onToggle }} />}
      {row.type && <span className="flex-none"><WorkTypeBadge type={row.type} /></span>}
      {summary && <span className="min-w-0 truncate" title={summary}>{summary}</span>}
      <PreviewCountBadge count={row.previewCount} />
    </div>
  );
};

/**
 * The rolled-up runs of one row as a self-contained timeline hanging off the
 * toggle's caret: `when · what it did · summary · [ ■ 6 ]`. Each run reads as one cluster.
 * A review ends on its bracketed score, so the tree tells the review-and-fix
 * story (a `REVIEW [ ▲ 4 ]`, the fixes it asked for, a `REVIEW [ ■ 6 ]`) as
 * the task pane's timeline does. A fix scores nothing of its own and shows none.
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
      const score = runScore(run);
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
              {score != null && <span data-testid="run-score" className="ml-auto flex-none"><ScoreBadge score={score} bracketed className="!w-auto !min-w-0 !max-w-none !text-xs" label="Review score" /></span>}
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
  /** The task opens beside the list, whose timeline reaches its earlier runs. */
  selectsInPlace?: boolean;
}

/** One ledger row: TASK / PR · REPO · STATUS · AGENT · ASSIGNEES · DURATION · UPDATED · SCORE. */
export const TaskQueueRow: React.FC<TaskQueueRowProps> = ({ row, prNumber, expanded, onRowClick, onToggle, selectedTaskId, selectsInPlace = false }) => {
  const { task } = row;
  const runsId = `task-runs-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const selected = rowContainsTask(row, selectedTaskId);
  return (
    <div role="presentation" className="border-b border-slate-200" data-testid="task-row">
      <div
        role="row"
        aria-selected={selected}
        className={`task-queue-grid task-queue-row pl-8 pr-6 cursor-pointer py-2 transition-colors ${selected ? SELECTED_ROW_CLASSES : 'hover:bg-slate-50'}`}
        onClick={event => openRow(event, task.id, onRowClick)}
      >
        <div role="cell" className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="flex-none"><TaskPrimaryChip task={task} prNumber={prNumber} /></span>
            {/* One line, ending in `…`: a long title never wraps, so every title starts at the chip and every row is two lines. */}
            <TaskTitleLink title={row.title} tooltip={row.fullTitle} taskId={task.id} onRowClick={onRowClick} selected={selected} singleLine />
          </div>
          <RollupLine row={row} expanded={expanded} runsId={runsId} onToggle={onToggle} selectsInPlace={selectsInPlace} />
        </div>
        <div role="cell" className="min-w-0"><TaskRepository row={row} /></div>
        <div role="cell" className="min-w-0">{getStatusPill(getDisplayStatus(task))}</div>
        <div role="cell" className="min-w-0"><TaskAgent task={task} /></div>
        <div role="cell" className="min-w-0"><TaskAssignees row={row} /></div>
        <div role="cell" className="whitespace-nowrap text-right font-mono text-xs tabular-nums text-slate-700">{taskDuration(task)}</div>
        <div role="cell" className="whitespace-nowrap text-right text-xs tabular-nums text-slate-500">
          <time dateTime={task.createdAt} title={new Date(task.createdAt).toLocaleString()}>{formatRelativeTime(task.createdAt)}</time>
        </div>
        <div role="cell" className="justify-items-end"><TaskScore row={row} /></div>
      </div>
      {!selectsInPlace && expanded && row.earlierRuns.length > 0 && (
        <div role="row" className="task-queue-grid pl-8 pr-6 pb-2">
          <div role="cell" aria-colspan={TASK_RUNS_COLUMN_SPAN} className="task-runs-cell min-w-0">
            <EarlierRunsList id={runsId} runs={row.earlierRuns} onRowClick={onRowClick} selectedTaskId={selectedTaskId} />
          </div>
        </div>
      )}
    </div>
  );
};
