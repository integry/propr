import React from 'react';
import ContextStrip from './ContextStrip';
import ActionBar from './ActionBar';
import TaskHeader, { TaskStatusBadge } from './TaskHeader';
import { getDisplayTitle, getSubtitle } from './taskHeaderText';

interface DesktopTaskHeaderProps {
  headerProps: React.ComponentProps<typeof TaskHeader>;
  contextStripProps: React.ComponentProps<typeof ContextStrip>;
  actionBarProps: React.ComponentProps<typeof ActionBar>;
  /** The newest run and how many there are, when the task has more than one. */
  runCount?: number;
  /** The pane's own controls (open full page, close), docked after the task's actions. */
  paneControls?: React.ReactNode;
}

/**
 * The task in two tiers. The first says where the task lives and what state
 * it is in, with its actions and the pane's controls on the right. The second
 * is its title, then how its newest run is going: which run, the model, the
 * runtime and the consumption. Both always describe the task, never a run the
 * timeline opened below.
 */
const DesktopTaskHeader: React.FC<DesktopTaskHeaderProps> = ({ headerProps, contextStripProps, actionBarProps, runCount, paneControls }) => {
  const { taskInfo } = headerProps;
  const title = getDisplayTitle(taskInfo?.title);
  const subtitle = taskInfo ? getSubtitle(taskInfo) : undefined;
  const lead = runCount
    ? <><span className="font-medium text-slate-800">Run {runCount}/{runCount}</span>{subtitle && ` · ${subtitle}`}</>
    : subtitle;

  return (
    <div data-testid="task-header-tiers" className="flex flex-col gap-1 border-b border-slate-200 px-6 py-2">
      <div data-testid="task-header-identity" className="flex min-h-8 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <ContextStrip {...contextStripProps} part="git" />
          <span aria-hidden="true" className="text-gray-300">•</span>
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
      <ContextStrip {...contextStripProps} part="telemetry" lead={lead} />
    </div>
  );
};

export default DesktopTaskHeader;
