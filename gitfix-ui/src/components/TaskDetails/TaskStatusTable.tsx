import React, { useMemo } from 'react';
import { HistoryItem } from './types';
import { formatDateOnly, formatTimeOnly, formatRelativeTime } from './utils';
import { Clock, Loader2, CheckCircle2, XCircle, CircleDot, Timer, GitPullRequest } from 'lucide-react';

interface TaskStatusTableProps {
  history: HistoryItem[];
  compact?: boolean;
}

const getDisplayLabel = (item: HistoryItem, index: number, history: HistoryItem[]): string => {
  const stateUpper = item.state?.toUpperCase();

  if (stateUpper === 'PENDING') return 'Task Queued';
  if (stateUpper === 'PROCESSING') return 'Analyzing Request';
  if (stateUpper === 'CLAUDE_EXECUTION' || stateUpper === 'CLAUDE_EXECUTION_STARTED') {
    return getClaudeExecutionLabel(item, index, history);
  }
  if (stateUpper === 'CLAUDE_EXECUTION_COMPLETED') return 'Implementation Completed';
  if (stateUpper === 'POST_PROCESSING') return 'Creating Pull Request';
  if (stateUpper === 'COMPLETED') return 'Task Completed';
  if (stateUpper === 'FAILED') return 'Task Failed';

  return item.state?.replace(/_/g, ' ').toLowerCase() || '';
};

const getClaudeExecutionLabel = (item: HistoryItem, index: number, history: HistoryItem[]): string => {
  const claudeCount = history.slice(0, index + 1).filter(h => {
    const s = h.state?.toUpperCase();
    return s === 'CLAUDE_EXECUTION' || s === 'CLAUDE_EXECUTION_STARTED';
  }).length;

  if (item.reason?.toLowerCase().includes('completed')) return 'Implementation Completed';
  if (item.reason?.toLowerCase().includes('started')) {
    return claudeCount === 1 ? 'Implementing Changes' : `Retry Implementation ${claudeCount}`;
  }
  if (item.metadata?.description) return item.metadata.description;
  return claudeCount === 1 ? 'Implementing Changes' : `Retry Implementation ${claudeCount}`;
};

const TimelineIcon: React.FC<{ state: string; isRunning: boolean; isFailure: boolean }> = ({
  state,
  isRunning,
  isFailure
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
    <div className={`flex items-center my-2 ${compact ? 'ml-16' : 'ml-24'}`}>
      <div className="h-px bg-gray-200 flex-grow"></div>
      <span className="px-2 text-xs font-medium text-gray-400 uppercase tracking-wider">{currentDate}</span>
      <div className="h-px bg-gray-200 flex-grow"></div>
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
}> = ({ item, index, history, maxDurationIndex, isRunning, compact }) => {
  const displayLabel = getDisplayLabel(item, index, history);
  const prInfo = item.metadata?.pr || item.metadata?.pullRequest;
  const isCompleted = item.state?.toUpperCase() === 'COMPLETED';

  return (
    <div className={`flex-grow ${isCompleted ? 'mt-1' : ''} ${compact ? 'pb-3' : 'pb-6'}`}>
      <div className="flex justify-between items-center">
        <div>
          <div className={`${compact ? 'text-xs' : 'text-sm'} ${index === maxDurationIndex ? 'font-bold text-gray-900' : 'font-medium text-gray-700'}`}>
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
        </div>

        {/* Duration */}
        <div className="text-right pl-4">
          {item.duration !== null && (
            <span className={`${compact ? 'text-xs' : 'text-sm'} ${index === maxDurationIndex ? 'font-bold text-gray-800' : 'text-gray-500'}`}>
              {formatRelativeTime(item.duration)}
            </span>
          )}
          {isRunning && (
            <span className={`${compact ? 'text-xs' : 'text-xs'} text-blue-600 animate-pulse font-medium`}>Running...</span>
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
}> = ({ item, index, history, maxDurationIndex, isLast, compact }) => {
  const stateUpper = item.state?.toUpperCase() || '';
  const isCompletedState = ['COMPLETED', 'FAILED'].includes(stateUpper);
  const isRunning = isLast && !isCompletedState;
  const isFailure = stateUpper === 'FAILED';

  // Check if date changed from previous item
  const prevDate = index > 0 && history[index - 1].timestamp ? formatDateOnly(history[index - 1].timestamp!) : null;
  const currentDate = item.timestamp ? formatDateOnly(item.timestamp) : null;

  return (
    <React.Fragment>
      <TimelineDateDivider prevDate={prevDate} currentDate={currentDate} compact={compact} />

      <div className={`flex group ${compact ? 'min-h-[2rem]' : 'min-h-[3rem]'}`}>
        {/* Time Column */}
        <div className={`${compact ? 'w-16' : 'w-24'} flex-shrink-0 text-right pr-3`}>
          <span className={`${compact ? 'text-xs' : 'text-sm'} text-gray-500 font-mono`}>
            {item.timestamp ? formatTimeOnly(item.timestamp) : '--:--'}
          </span>
        </div>

        {/* Timeline Graphic */}
        <div className="relative flex flex-col items-center mr-3">
          {/* Upper Line */}
          <div className={`w-0.5 bg-gray-200 absolute top-0 bottom-0 left-1/2 -translate-x-1/2 ${index === 0 ? 'top-3' : ''} ${isLast ? 'h-3' : ''}`}></div>

          {/* Icon/Dot */}
          <div className="relative z-10 bg-white p-0.5">
            <TimelineIcon state={stateUpper} isRunning={isRunning} isFailure={isFailure} />
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
        />
      </div>
    </React.Fragment>
  );
};

const TaskStatusTable: React.FC<TaskStatusTableProps> = ({ history, compact = false }) => {
  // Pre-calculate durations to find the longest one for highlighting
  const { itemsWithDuration, maxDurationIndex, startDate } = useMemo(() => {
    if (!history || history.length === 0) {
      return { itemsWithDuration: [], maxDurationIndex: -1, startDate: '' };
    }

    let maxDur = 0;
    let maxIdx = -1;

    const processed = history.map((item, index) => {
      const nextItem = history[index + 1];
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
      startDate: history[0].timestamp ? formatDateOnly(history[0].timestamp) : ''
    };
  }, [history]);

  if (!history || history.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className={`bg-gray-50 ${compact ? 'px-4 py-3' : 'px-6 py-4'} border-b border-gray-200`}>
        <h4 className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-gray-900`}>
          Status Timeline
          {startDate && <span className={`ml-2 ${compact ? 'text-xs' : 'text-sm'} font-normal text-gray-500`}>(Started {startDate})</span>}
        </h4>
      </div>

      <div className={compact ? 'p-4' : 'p-6'}>
        <div className="relative">
          {itemsWithDuration.map((item, index) => (
            <TaskTimelineItem
              key={index}
              item={item}
              index={index}
              history={history}
              maxDurationIndex={maxDurationIndex}
              isLast={index === itemsWithDuration.length - 1}
              compact={compact}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default TaskStatusTable;
