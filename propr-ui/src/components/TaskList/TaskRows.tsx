import React from 'react';
import { Images } from 'lucide-react';
import type { Task } from './types';
import { getStatusPill, getDisplayStatus, formatRelativeTime, formatDuration, shouldDimTask } from './utils.tsx';
import { ScoreBadge } from './ScoreBadge';
import { ProviderLogo } from '../ui/ProviderLogo';
import { RepositoryChip } from '../ui/RepositoryChip';
import { ReferenceChip } from './ReferenceChips';
import { WorkTypeBadge } from '../Dashboard/sectionPrimitives';
import { getModelDisplayName } from '../../utils/modelDisplay';
import { pluralize, type TaskRowView, type TaskRunView } from './rowModel';

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

/** Bracketed `[ ● 9 ]` pill, or a quiet dash so the column never collapses. */
export const TaskScore: React.FC<{ task: Task }> = ({ task }) => (
  task.critiqueScore === null || task.critiqueScore === undefined
    ? <span className="text-xs text-slate-300" aria-label="No score">—</span>
    : <ScoreBadge score={task.critiqueScore} bracketed dimmed={shouldDimTask(task)} />
);

const TaskTitleButton: React.FC<{ title: string; taskId: string; onRowClick: (id: string) => void }> = ({ title, taskId, onRowClick }) => (
  <button
    type="button"
    className="task-title min-w-0 truncate text-left text-sm font-medium text-slate-900"
    title={title}
    onClick={event => {
      event.stopPropagation();
      if (event.detail > 0 && window.getSelection()?.toString()) return;
      onRowClick(taskId);
    }}
  >
    {title}
  </button>
);

/** `↳ 6 earlier runs · what the newest run did`, held to one line. */
export const RollupLine: React.FC<{
  row: TaskRowView;
  expanded: boolean;
  runsId: string;
  onToggle: (groupKey: string, e: React.MouseEvent) => void;
}> = ({ row, expanded, runsId, onToggle }) => {
  const count = row.earlierRuns.length;
  if (!count && !row.detail) return null;
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-5 text-slate-500">
      {count > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={runsId}
          onClick={event => onToggle(row.key, event)}
          className="flex-none rounded-sm hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        >
          <span aria-hidden="true">{expanded ? '▾' : '↳'} </span>
          {expanded ? 'Hide ' : ''}{count} earlier {count === 1 ? 'run' : 'runs'}
        </button>
      ) : row.detail ? <span aria-hidden="true" className="flex-none">↳</span> : null}
      {row.detail && (
        <span className="min-w-0 truncate" title={row.detail}>
          {count > 0 && <span aria-hidden="true">· </span>}{row.detail}
        </span>
      )}
    </div>
  );
};

/** The rolled-up runs of one row, each a single line that opens that run. */
export const EarlierRunsList: React.FC<{
  id: string;
  runs: TaskRunView[];
  onRowClick: (taskId: string) => void;
}> = ({ id, runs, onRowClick }) => (
  <ul id={id} aria-label="Earlier runs" className="task-earlier-runs space-y-0.5 border-l-2 border-slate-200 pl-3">
    {runs.map(run => (
      <li key={run.task.id}>
        <button
          type="button"
          onClick={() => onRowClick(run.task.id)}
          className="task-run grid w-full min-w-0 items-center gap-x-3 rounded-sm px-1 py-0.5 text-left text-xs leading-5 text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        >
          <time dateTime={run.task.createdAt} title={new Date(run.task.createdAt).toLocaleString()} className="whitespace-nowrap font-mono text-[11px] tabular-nums text-slate-400">
            {formatRelativeTime(run.task.createdAt)}
          </time>
          <span className="min-w-0">{run.type ? <WorkTypeBadge type={run.type} compact /> : null}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-slate-700" title={run.delta}>{run.delta}</span>
            <PreviewCountBadge count={run.previewCount} />
          </span>
          <span className="task-run-status">{getStatusPill(getDisplayStatus(run.task))}</span>
          <span className="task-run-duration whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-slate-500">{taskDuration(run.task)}</span>
          <span className="flex justify-end"><TaskScore task={run.task} /></span>
        </button>
      </li>
    ))}
  </ul>
);

interface TaskQueueRowProps {
  row: TaskRowView;
  prNumber?: number | null;
  expanded: boolean;
  onRowClick: (taskId: string) => void;
  onToggle: (groupKey: string, e: React.MouseEvent) => void;
}

/** One ledger row: TASK / PR · REPO · STATUS · AGENT · DURATION · UPDATED · SCORE. */
export const TaskQueueRow: React.FC<TaskQueueRowProps> = ({ row, prNumber, expanded, onRowClick, onToggle }) => {
  const { task } = row;
  const runsId = `task-runs-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return (
    <div role="presentation" className="border-b border-slate-200" data-testid="task-row">
      <div
        role="row"
        className="task-queue-grid cursor-pointer px-4 py-2 transition-colors hover:bg-slate-50 sm:px-6"
        onClick={event => openRow(event, task.id, onRowClick)}
      >
        <div role="cell" className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <TaskPrimaryChip task={task} prNumber={prNumber} />
            {row.type && <WorkTypeBadge type={row.type} compact />}
            <TaskTitleButton title={row.title} taskId={task.id} onRowClick={onRowClick} />
            <PreviewCountBadge count={row.previewCount} />
          </div>
          <RollupLine row={row} expanded={expanded} runsId={runsId} onToggle={onToggle} />
        </div>
        <div role="cell" className="task-col-repo min-w-0">
          <RepositoryChip repository={row.repository} />
        </div>
        <div role="cell" className="task-col-status min-w-0">{getStatusPill(getDisplayStatus(task))}</div>
        <div role="cell" className="task-col-agent min-w-0"><TaskAgent task={task} /></div>
        <div role="cell" className="task-col-duration whitespace-nowrap text-right font-mono text-xs tabular-nums text-slate-700">{taskDuration(task)}</div>
        <div role="cell" className="task-col-updated whitespace-nowrap text-right text-xs tabular-nums text-slate-500">
          <time dateTime={task.createdAt} title={new Date(task.createdAt).toLocaleString()}>{formatRelativeTime(task.createdAt)}</time>
        </div>
        <div role="cell" className="task-col-score flex justify-end"><TaskScore task={task} /></div>
      </div>
      {expanded && row.earlierRuns.length > 0 && (
        <div role="row" className="task-runs-row px-4 pb-2 sm:px-6">
          <div role="cell" className="task-runs-cell">
            <EarlierRunsList id={runsId} runs={row.earlierRuns} onRowClick={onRowClick} />
          </div>
        </div>
      )}
    </div>
  );
};
