import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import ContextStrip from './ContextStrip';
import ActionBar from './ActionBar';
import TaskHeader, { RunStateLabel, TaskStatusBadge } from './TaskHeader';
import { getDisplayTitle, getSubtitle } from './taskHeaderText';

interface DesktopTaskHeaderProps {
  headerProps: React.ComponentProps<typeof TaskHeader>;
  contextStripProps: React.ComponentProps<typeof ContextStrip>;
  /** The run on screen's own model, runtime and consumption. */
  runStripProps: React.ComponentProps<typeof ContextStrip>;
  /** How the run on screen ended, and when it last did anything. */
  runState: { status: string; isActive: boolean; lastActivity?: string };
  actionBarProps: React.ComponentProps<typeof ActionBar>;
  /** The run on screen, when the task has more than one. */
  run?: { number: number; count: number };
  /** The pane's own controls (open full page, close), docked after the task's actions. */
  paneControls?: React.ReactNode;
  /** The full page's way back to the list it was opened from, above the task. */
  breadcrumb?: boolean;
}

/** Task types recorded for a pull request: `pr` for the PR itself, `pr-comment` for a follow-up on it. */
const PR_TASK_TYPES = new Set<string | undefined>(['pr', 'pr-comment']);

/** What the breadcrumb calls the task: its pull request or issue, else just the task. */
const crumbLabel = (taskInfo: DesktopTaskHeaderProps['headerProps']['taskInfo']) => {
  if (!taskInfo?.number) return 'Task';
  return `${PR_TASK_TYPES.has(taskInfo.type) ? 'PR' : 'Issue'} #${taskInfo.number}`;
};

/** `← Tasks / PR #2720`: the full page has no list beside it, so it links back to one. */
const TaskBreadcrumb: React.FC<{ label: string }> = ({ label }) => (
  <nav aria-label="Breadcrumb" data-testid="task-breadcrumb" className="flex items-center gap-1.5 text-xs text-slate-500">
    <Link
      to="/tasks"
      className="inline-flex items-center gap-1 rounded font-medium text-slate-600 transition-colors hover:text-slate-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
    >
      <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
      Tasks
    </Link>
    <span aria-hidden="true" className="text-slate-300">/</span>
    <span aria-current="page" className="font-mono text-slate-500">{label}</span>
  </nav>
);

/**
 * The task in two tiers. The first is the task: where it lives, what state it
 * is in, with its actions (Stop included, while its newest run works) and the
 * pane's controls on the right. It never changes when the timeline opens an
 * earlier run. The second is the title, then the run on screen: which run it
 * is and how it ended, its model, runtime and consumption, so every run's
 * spend can be read, and the run number says whose it is.
 */
const DesktopTaskHeader: React.FC<DesktopTaskHeaderProps> = ({ headerProps, contextStripProps, runStripProps, runState, actionBarProps, run, paneControls, breadcrumb }) => {
  const { taskInfo } = headerProps;
  const title = getDisplayTitle(taskInfo?.title);
  const runInfo = runStripProps.taskInfo;
  const subtitle = runInfo ? getSubtitle(runInfo) : undefined;
  const lead = run
    ? (
      <>
        {/* The live run's state is the status pill above; only an earlier run says how it ended. */}
        <span data-testid="header-run-label" className="font-medium text-slate-800">
          Run {run.number}/{run.count}
          {!runState.isActive && <span className="font-normal text-slate-500"> (<RunStateLabel {...runState} commandMode={runInfo?.commandMode} />)</span>}
          {subtitle && ':'}
        </span>
        {subtitle && ` ${subtitle}`}
      </>
    )
    : subtitle;

  return (
    <div data-testid="task-header-tiers" className="flex flex-col gap-1 border-b border-slate-200 px-6 py-2">
      {breadcrumb && <TaskBreadcrumb label={crumbLabel(taskInfo)} />}
      <div data-testid="task-header-identity" className="flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <ContextStrip {...contextStripProps} part="git" />
          <TaskStatusBadge {...headerProps} />
        </div>
        <div className="flex flex-none items-center gap-1">
          <ActionBar {...actionBarProps} />
          {paneControls && (
            <div className="ml-1 flex items-center gap-0.5 border-l border-slate-200 pl-2">{paneControls}</div>
          )}
        </div>
      </div>
      <h2 className="text-base font-semibold leading-tight text-gray-900 break-words line-clamp-2" title={title.tooltip}>
        {title.text || 'Loading...'}
      </h2>
      <ContextStrip {...runStripProps} part="telemetry" lead={lead} />
    </div>
  );
};

export default DesktopTaskHeader;
