import React, { useMemo } from 'react';
import { formatTaskTerminalReason } from '@propr/shared';
import { HistoryItem } from './types';
import PushFailureDetails from './PushFailureDetails';
import { formatDateOnly, formatTimeOnly, formatRelativeTime } from './utils';
import { RUN_DURATION_COLUMN, RUN_LEAD_INSET, RUN_TAG_COLUMN } from './runTimelineColumns';
import { Clock, Loader2, CheckCircle2, XCircle, CircleDot, Timer, GitPullRequest, Ban } from 'lucide-react';

interface TaskStatusTableProps {
  history: HistoryItem[];
  compact?: boolean;
  commandMode?: 'default' | 'review' | 'fix' | 'switch' | 'use' | 'ultrafix';
  /**
   * `branch` draws the steps as tics off the task timeline's run rail, under
   * the run they belong to: `├── 11:59:12  Read the handlers   12s`.
   */
  variant?: 'rail' | 'branch';
}

const getDisplayLabel = (item: HistoryItem, index: number, history: HistoryItem[], commandMode?: string): string => {
  const stateUpper = item.state?.toUpperCase();
  const isReview = commandMode === 'review';
  const isFix = commandMode === 'fix';

  if (item.metadata?.repositoryWorkflowDeferrals) return 'Waiting for Repository Capacity';
  if (stateUpper === 'PENDING') return 'Task Queued';
  if (stateUpper === 'PROCESSING') return isReview ? 'Preparing Review' : 'Analyzing Request';
  if (stateUpper === 'CLAUDE_EXECUTION' || stateUpper === 'CLAUDE_EXECUTION_STARTED') {
    return getClaudeExecutionLabel(item, index, history, commandMode);
  }
  if (stateUpper === 'CLAUDE_EXECUTION_COMPLETED') return isReview ? 'Review Completed' : isFix ? 'Fix Completed' : 'Implementation Completed';
  if (stateUpper === 'POST_PROCESSING') return 'Creating Pull Request';
  if (stateUpper === 'COMPLETED') return isReview ? 'Review Completed' : 'Task Completed';
  if (stateUpper === 'FAILED') return 'Task Failed';
  if (stateUpper === 'CANCELLED') return 'Task Cancelled';

  return item.state?.replace(/_/g, ' ').toLowerCase() || '';
};

const getClaudeExecutionLabel = (item: HistoryItem, index: number, history: HistoryItem[], commandMode?: string): string => {
  const routing = item.metadata?.syntheticRouting;
  if (routing) {
    const attempt = routing.attemptNumber ?? history.slice(0, index + 1)
      .filter(entry => entry.metadata?.syntheticRouting).length;
    const physical = [routing.physicalAgentAlias, routing.physicalModel].filter(Boolean).join(' · ');
    return `Pool attempt ${attempt}${physical ? ` — ${physical}` : ''}`;
  }
  const isReview = commandMode === 'review';
  const isFix = commandMode === 'fix';
  const claudeCount = history.slice(0, index + 1).filter(h => {
    const s = h.state?.toUpperCase();
    return s === 'CLAUDE_EXECUTION' || s === 'CLAUDE_EXECUTION_STARTED';
  }).length;

  const actionLabel = isReview ? 'Reviewing' : isFix ? 'Applying Fix' : 'Implementing Changes';
  const completedLabel = isReview ? 'Review Completed' : isFix ? 'Fix Completed' : 'Implementation Completed';

  if (item.reason?.toLowerCase().includes('completed')) return completedLabel;
  if (item.reason?.toLowerCase().includes('started')) {
    return claudeCount === 1 ? actionLabel : `Retry ${actionLabel} ${claudeCount}`;
  }
  if (item.metadata?.description) return item.metadata.description;
  return claudeCount === 1 ? actionLabel : `Retry ${actionLabel} ${claudeCount}`;
};

const TimelineIcon: React.FC<{ state: string; isRunning: boolean; isFailure: boolean; isCancelled: boolean }> = ({
  state,
  isRunning,
  isFailure,
  isCancelled
}) => {
  const stateUpper = state?.toUpperCase() || '';

  if (isRunning) {
    return (
      <div className="h-5 w-5 text-blue-600">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (isFailure) {
    return <XCircle className="h-5 w-5 text-red-500" />;
  }

  if (isCancelled) {
    return <Ban className="h-5 w-5 text-orange-500" />;
  }

  // Specific icons for different states
  if (stateUpper === 'PENDING') {
    return <Clock className="h-5 w-5 text-gray-400" />;
  }
  if (stateUpper === 'PROCESSING') {
    return <Timer className="h-5 w-5 text-blue-500" />;
  }
  if (stateUpper === 'POST_PROCESSING') {
    return <GitPullRequest className="h-5 w-5 text-purple-500" />;
  }
  if (stateUpper === 'COMPLETED') {
    return <CheckCircle2 className="h-5 w-5 text-green-500" />;
  }
  if (stateUpper.includes('CLAUDE_EXECUTION')) {
    return <CircleDot className="h-5 w-5 text-blue-500" />;
  }

  return <CheckCircle2 className="h-5 w-5 text-green-500" />;
};

const TimelineDateDivider: React.FC<{
  prevDate: string | null;
  currentDate: string | null;
  compact?: boolean;
}> = ({ prevDate, currentDate, compact }) => {
  const showDateDivider = prevDate && currentDate && prevDate !== currentDate;

  if (!showDateDivider) return null;

  return (
    <div className={`flex items-center my-2 ${compact ? 'ml-12 sm:ml-16' : 'ml-14 sm:ml-24'}`}>
      <div className="h-px bg-gray-200 flex-grow"></div>
      <span className="px-2 text-xs font-medium text-gray-400 uppercase tracking-wider">{currentDate}</span>
      <div className="h-px bg-gray-200 flex-grow"></div>
    </div>
  );
};

/** Why a queued task is not progressing; the retry time only matters while it is still waiting. */
const RepositoryWorkflowDeferral: React.FC<{ metadata?: HistoryItem['metadata']; isRunning: boolean }> = ({ metadata, isRunning }) => {
  const deferrals = metadata?.repositoryWorkflowDeferrals;
  if (!deferrals) return null;
  const retryAt = isRunning ? metadata?.repositoryWorkflowRetryAt : undefined;
  return (
    <div className="mt-1 break-words text-xs text-slate-500" data-testid="repository-workflow-deferral">
      {`Admission deferred ${deferrals} ${deferrals === 1 ? 'time' : 'times'}`}
      {retryAt ? ` · next retry ${formatTimeOnly(retryAt)}` : ''}
    </div>
  );
};

const TimelineContent: React.FC<{
  item: HistoryItem & { duration: number | null };
  index: number;
  history: HistoryItem[];
  maxDurationIndex: number;
  isRunning: boolean;
  compact?: boolean;
  commandMode?: string;
}> = ({ item, index, history, maxDurationIndex, isRunning, compact, commandMode }) => {
  const displayLabel = getDisplayLabel(item, index, history, commandMode);
  const prInfo = item.metadata?.pr || item.metadata?.pullRequest;
  const routing = item.metadata?.syntheticRouting;

  return (
    <div className={`min-w-0 flex-grow ${compact ? 'pb-3' : 'pb-6'}`}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`break-words ${compact ? 'text-xs' : 'text-sm'} leading-6 ${index === maxDurationIndex ? 'font-bold text-gray-900' : 'font-medium text-gray-700'}`}>
            {displayLabel}
            {prInfo?.url && (
              <a
                href={prInfo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-xs font-normal text-blue-600 hover:underline inline-flex items-center"
              >
                (View PR #{prInfo.number})
                <svg className="w-3 h-3 ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            )}
          </div>
          {item.metadata?.repositoryWorkflow && (
            <div className="mt-1 break-words text-xs text-slate-500" title={`Base commit: ${item.metadata.repositoryWorkflow.revision}; workflow blob: ${item.metadata.repositoryWorkflow.fileRevision}`}>
              Workflow: {item.metadata.repositoryWorkflow.path}
              <span className="block break-all">{item.metadata.repositoryWorkflow.baseBranch} @ {item.metadata.repositoryWorkflow.revision.slice(0, 12)}</span>
            </div>
          )}
          <RepositoryWorkflowDeferral metadata={item.metadata} isRunning={isRunning} />
          {item.metadata?.terminalReason && (
            <div className="mt-1 break-words text-xs text-slate-500" data-testid="task-terminal-reason">
              {formatTaskTerminalReason(item.metadata.terminalReason)}
            </div>
          )}
          <PushFailureDetails metadata={item.metadata} />
          {routing && (
            <div className="mt-0.5 break-words text-[10px] text-slate-500">
              Virtual {routing.virtualAgentAlias} · {routing.virtualModel}
              {routing.selectionReason ? ` · ${routing.selectionReason}` : ''}
            </div>
          )}
        </div>

        {/* Duration */}
        <div className="flex-shrink-0 text-right leading-6">
          {item.duration !== null && (
            <span className={`${compact ? 'text-xs' : 'text-sm'} ${index === maxDurationIndex ? 'font-bold text-gray-800' : 'text-gray-500'}`}>
              {formatRelativeTime(item.duration)}
            </span>
          )}
          {isRunning && (
            <span className="text-xs text-blue-600 animate-pulse font-medium">Running...</span>
          )}
        </div>
      </div>
    </div>
  );
};

const TaskTimelineItem: React.FC<{
  item: HistoryItem & { duration: number | null };
  index: number;
  history: HistoryItem[];
  maxDurationIndex: number;
  isLast: boolean;
  compact?: boolean;
  commandMode?: string;
}> = ({ item, index, history, maxDurationIndex, isLast, compact, commandMode }) => {
  const stateUpper = item.state?.toUpperCase() || '';
  const isCompletedState = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(stateUpper);
  const isRunning = isLast && !isCompletedState;
  const isFailure = stateUpper === 'FAILED';
  const isCancelled = stateUpper === 'CANCELLED';

  // Check if date changed from previous item
  const prevDate = index > 0 && history[index - 1].timestamp ? formatDateOnly(history[index - 1].timestamp!) : null;
  const currentDate = item.timestamp ? formatDateOnly(item.timestamp) : null;

  return (
    <React.Fragment>
      <TimelineDateDivider prevDate={prevDate} currentDate={currentDate} compact={compact} />

      <div className={`flex group ${compact ? 'min-h-[2rem]' : 'min-h-[2.5rem] sm:min-h-[3rem]'}`}>
        {/* Time Column */}
        <div className={`${compact ? 'w-16' : 'w-16 sm:w-24'} flex-shrink-0 text-right pr-2 sm:pr-3`}>
          <span className={`block ${compact ? 'text-xs' : 'text-xs sm:text-sm'} leading-6 text-gray-500 font-mono`}>
            {item.timestamp ? formatTimeOnly(item.timestamp) : '--:--'}
          </span>
        </div>

        {/* Timeline Graphic with Threading Rail */}
        <div className="relative flex flex-col items-center mr-2 sm:mr-3">
          {/* Continuous 2px solid vertical line connecting all icons */}
          <div className={`w-0.5 bg-slate-300 absolute top-0 bottom-0 left-1/2 -translate-x-1/2 ${index === 0 ? 'top-3' : ''} ${isLast ? 'h-3' : ''}`}></div>

          {/* Icon/Dot - intersects the rail */}
          <div className="relative z-10 bg-white p-0.5">
            <TimelineIcon state={stateUpper} isRunning={isRunning} isFailure={isFailure} isCancelled={isCancelled} />
          </div>
        </div>

        {/* Content Column */}
        <TimelineContent
          item={item}
          index={index}
          history={history}
          maxDurationIndex={maxDurationIndex}
          isRunning={isRunning}
          compact={compact}
          commandMode={commandMode}
        />
      </div>
    </React.Fragment>
  );
};

// Consecutive updates to a pipeline phase represent one lifecycle. Keep its
// original start time and latest metadata. Execution entries can be distinct
// retries, checkpoints, or pool attempts, so never collapse those by state.
const coalescePipelineHistory = (history: HistoryItem[]): HistoryItem[] => {
  const steps: HistoryItem[] = [];
  for (const item of history) {
    const previous = steps[steps.length - 1];
    const state = item.state?.toUpperCase();
    if (previous && ['PENDING', 'PROCESSING', 'POST_PROCESSING'].includes(state ?? '') &&
      previous.state?.toUpperCase() === state &&
      previous.metadata?.ultrafixCycle === item.metadata?.ultrafixCycle) {
      steps[steps.length - 1] = {
        ...previous, ...item,
        state: previous.state,
        timestamp: previous.timestamp ?? item.timestamp,
        metadata: { ...previous.metadata, ...item.metadata },
      };
    } else {
      steps.push(item);
    }
  }
  return steps;
};

/**
 * One run's steps hanging off the run rail (2px at 7px in): each step branches
 * off it with a tic under the run's caret, and keeps to the run row's columns:
 * its time in the tag column, its label under the run's summary, its duration
 * under the run's.
 */
const BranchSteps: React.FC<{
  items: Array<HistoryItem & { duration: number | null }>;
  history: HistoryItem[];
  commandMode?: string;
}> = ({ items, history, commandMode }) => (
  <ol aria-label="Run steps" className="m-0 list-none p-0">
    {items.map((item, index) => {
      const stateUpper = item.state?.toUpperCase() || '';
      const isLast = index === items.length - 1;
      const isRunning = isLast && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(stateUpper);
      const isFailure = stateUpper === 'FAILED';
      return (
        <li key={`${item.state}-${item.timestamp}-${index}`} className={`relative flex min-w-0 items-start gap-2 py-0.5 ${RUN_LEAD_INSET} pr-1 text-xs leading-5`}>
          <span aria-hidden="true" className="absolute left-[9px] top-[10px] h-px w-6 bg-slate-300" />
          <span className={`${RUN_TAG_COLUMN} flex-none font-mono text-[11px] tabular-nums text-slate-400`}>
            {item.timestamp ? formatTimeOnly(item.timestamp) : '--:--'}
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block break-words ${isFailure ? 'font-medium text-red-700' : isRunning ? 'font-medium text-slate-900' : 'text-slate-600'}`}>
              {getDisplayLabel(item, index, history, commandMode)}
            </span>
            {item.metadata?.terminalReason && (
              <span className="block break-words text-[11px] text-slate-500" data-testid="task-terminal-reason">
                {formatTaskTerminalReason(item.metadata.terminalReason)}
              </span>
            )}
            <PushFailureDetails metadata={item.metadata} />
          </span>
          <span className={`${RUN_DURATION_COLUMN} flex-none whitespace-nowrap text-right font-mono text-[11px] tabular-nums ${isRunning ? 'font-medium text-teal-700' : 'text-slate-500'}`}>
            {isRunning ? 'Running…' : item.duration !== null ? formatRelativeTime(item.duration) : ''}
          </span>
        </li>
      );
    })}
  </ol>
);

const TaskStatusTable: React.FC<TaskStatusTableProps> = ({ history, compact = false, commandMode, variant = 'rail' }) => {
  const timelineHistory = useMemo(() => coalescePipelineHistory(history ?? []), [history]);

  // Pre-calculate durations to find the longest one for highlighting
  const { itemsWithDuration, maxDurationIndex, startDate } = useMemo(() => {
    if (timelineHistory.length === 0) {
      return { itemsWithDuration: [], maxDurationIndex: -1, startDate: '' };
    }

    let maxDur = 0;
    let maxIdx = -1;

    const processed = timelineHistory.map((item, index) => {
      const nextItem = timelineHistory[index + 1];
      const duration = nextItem && item.timestamp && nextItem.timestamp
        ? new Date(nextItem.timestamp).getTime() - new Date(item.timestamp).getTime()
        : null;

      if (duration !== null && duration > maxDur) {
        maxDur = duration;
        maxIdx = index;
      }
      return { ...item, duration };
    });

    return {
      itemsWithDuration: processed,
      maxDurationIndex: maxIdx,
      startDate: timelineHistory[0].timestamp ? formatDateOnly(timelineHistory[0].timestamp) : ''
    };
  }, [timelineHistory]);

  if (!history || history.length === 0) return null;

  if (variant === 'branch') {
    return <BranchSteps items={itemsWithDuration} history={timelineHistory} commandMode={commandMode} />;
  }

  return (
    <div className="pt-2">
      {/* Start date shown as subtitle */}
      {startDate && (
        <div className="text-[10px] font-mono text-slate-400 mb-2">{startDate}</div>
      )}

      <div className="relative">
        {itemsWithDuration.map((item, index) => (
          <TaskTimelineItem
            key={`${item.state}-${item.timestamp}-${index}`}
            item={item}
            index={index}
            history={timelineHistory}
            maxDurationIndex={maxDurationIndex}
            isLast={index === itemsWithDuration.length - 1}
            compact={compact}
            commandMode={commandMode}
          />
        ))}
      </div>
    </div>
  );
};

export default TaskStatusTable;
