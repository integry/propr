import React, { useMemo } from 'react';
import { HistoryItem } from './types';
import { formatDateOnly, formatTimeOnly, formatRelativeTime } from './utils';

interface TaskStatusTableProps {
  history: HistoryItem[];
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

const getClaudeExecutionLabel = (
  item: HistoryItem,
  index: number,
  history: HistoryItem[]
): string => {
  const claudeCount = history.slice(0, index + 1).filter(h => {
    const s = h.state?.toUpperCase();
    return s === 'CLAUDE_EXECUTION' || s === 'CLAUDE_EXECUTION_STARTED';
  }).length;

  if (item.reason?.toLowerCase().includes('completed')) {
    return 'Implementation Completed';
  }
  if (item.reason?.toLowerCase().includes('started')) {
    return claudeCount === 1 ? 'Implementing Changes' : `Retry Implementation ${claudeCount}`;
  }
  if (item.metadata?.description) {
    return item.metadata.description;
  }
  return claudeCount === 1 ? 'Implementing Changes' : `Retry Implementation ${claudeCount}`;
};

interface ProcessedHistoryItem extends HistoryItem {
  duration: number | null;
}

// Extracted component to render the status icon
const StatusIcon: React.FC<{ isRunning: boolean; isFailure: boolean }> = ({ isRunning, isFailure }) => {
  if (isRunning) {
    return (
      <div className="h-4 w-4">
        <svg
          className="animate-spin h-4 w-4 text-blue-600"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          ></circle>
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
      </div>
    );
  }

  if (isFailure) {
    return (
      <div className="h-4 w-4 rounded-full bg-red-100 border border-red-500 flex items-center justify-center">
        <span className="text-[10px] text-red-600 font-bold">✕</span>
      </div>
    );
  }

  return (
    <div className="h-4 w-4 rounded-full bg-green-100 border border-green-500 flex items-center justify-center">
      <svg
        className="w-2.5 h-2.5 text-green-600"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={3}
          d="M5 13l4 4L19 7"
        />
      </svg>
    </div>
  );
};

// Date divider component
const DateDivider: React.FC<{ date: string }> = ({ date }) => (
  <div className="flex items-center my-4 ml-24">
    <div className="h-px bg-gray-200 flex-grow"></div>
    <span className="px-3 text-xs font-medium text-gray-400 uppercase tracking-wider">
      {date}
    </span>
    <div className="h-px bg-gray-200 flex-grow"></div>
  </div>
);

// PR link component
const PrLink: React.FC<{ url: string; number: number }> = ({ url, number }) => (
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    className="ml-2 text-xs font-normal text-blue-600 hover:underline inline-flex items-center"
  >
    (View PR #{number})
    <svg
      className="w-3 h-3 ml-0.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
      />
    </svg>
  </a>
);

// Timeline connector line component
const TimelineConnector: React.FC<{ isFirst: boolean; isLast: boolean }> = ({ isFirst, isLast }) => {
  const positionClass = isFirst ? 'top-3 bottom-0' : isLast ? 'top-0 h-3' : 'top-0 bottom-0';
  return (
    <div className={`w-0.5 bg-gray-200 absolute left-1/2 -translate-x-1/2 ${positionClass}`}></div>
  );
};

// Timeline item content component
interface TimelineItemContentProps {
  displayLabel: string;
  prInfo: { url: string; number: number } | null;
  showPrLink: boolean;
  duration: number | null;
  isHighlighted: boolean;
  isRunning: boolean;
}

const TimelineItemContent: React.FC<TimelineItemContentProps> = ({
  displayLabel,
  prInfo,
  showPrLink,
  duration,
  isHighlighted,
  isRunning
}) => (
  <div className="flex-grow pb-6 pt-0.5">
    <div className="flex justify-between items-start">
      <div>
        <div className={`text-sm ${isHighlighted ? 'font-bold text-gray-900' : 'font-medium text-gray-700'}`}>
          {displayLabel}
          {showPrLink && prInfo && <PrLink url={prInfo.url} number={prInfo.number} />}
        </div>
      </div>

      <div className="text-right pl-4">
        {duration !== null && (
          <span className={`text-sm ${isHighlighted ? 'font-bold text-gray-800' : 'text-gray-500'}`}>
            {formatRelativeTime(duration)}
          </span>
        )}
        {isRunning && (
          <span className="text-xs text-blue-600 animate-pulse font-medium">
            Running...
          </span>
        )}
      </div>
    </div>
  </div>
);

// Extracted component to render a timeline item
interface TimelineItemProps {
  item: ProcessedHistoryItem;
  index: number;
  history: HistoryItem[];
  isLast: boolean;
  maxDurationIndex: number;
  prevDate: string | null;
}

const TimelineItem: React.FC<TimelineItemProps> = ({
  item,
  index,
  history,
  isLast,
  maxDurationIndex,
  prevDate
}) => {
  const stateUpper = item.state?.toUpperCase() || '';
  const isCompletedState = ['COMPLETED', 'FAILED'].includes(stateUpper);
  const isRunning = isLast && !isCompletedState;
  const isFailure = stateUpper === 'FAILED';

  const currentDate = item.timestamp ? formatDateOnly(item.timestamp) : null;
  const showDateDivider = prevDate && currentDate && prevDate !== currentDate;

  const displayLabel = getDisplayLabel(item, index, history);
  const prInfo = item.metadata?.pr || item.metadata?.pullRequest;
  const showPrLink = ['COMPLETED', 'POST_PROCESSING'].includes(stateUpper) && !!prInfo?.url;

  return (
    <React.Fragment>
      {showDateDivider && currentDate && <DateDivider date={currentDate} />}

      <div className="flex group min-h-[3rem]">
        <div className="w-24 flex-shrink-0 text-right pr-4 pt-1">
          <span className="text-sm text-gray-500 font-mono">
            {item.timestamp ? formatTimeOnly(item.timestamp) : '--:--:--'}
          </span>
        </div>

        <div className="relative flex flex-col items-center mr-4">
          <TimelineConnector isFirst={index === 0} isLast={isLast} />
          <div className="relative z-10 bg-white p-0.5">
            <StatusIcon isRunning={isRunning} isFailure={isFailure} />
          </div>
        </div>

        <TimelineItemContent
          displayLabel={displayLabel}
          prInfo={prInfo ? { url: prInfo.url, number: prInfo.number } : null}
          showPrLink={showPrLink}
          duration={item.duration}
          isHighlighted={index === maxDurationIndex}
          isRunning={isRunning}
        />
      </div>
    </React.Fragment>
  );
};

const TaskStatusTable: React.FC<TaskStatusTableProps> = ({ history }) => {
  const { itemsWithDuration, maxDurationIndex, startDate } = useMemo(() => {
    if (!history || history.length === 0) {
      return { itemsWithDuration: [], maxDurationIndex: -1, startDate: '' };
    }

    let maxDur = 0;
    let maxIdx = -1;

    const processed: ProcessedHistoryItem[] = history.map((item, index) => {
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
      startDate: history[0]?.timestamp ? formatDateOnly(history[0].timestamp) : ''
    };
  }, [history]);

  if (!history || history.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
        <h4 className="text-lg font-semibold text-gray-900">
          Status Timeline
          {startDate && <span className="ml-2 text-sm font-normal text-gray-500">(Started {startDate})</span>}
        </h4>
      </div>

      <div className="p-6">
        <div className="relative">
          {itemsWithDuration.map((item, index) => {
            const prevDate = index > 0 && history[index - 1].timestamp
              ? formatDateOnly(history[index - 1].timestamp!)
              : null;

            return (
              <TimelineItem
                key={index}
                item={item}
                index={index}
                history={history}
                isLast={index === itemsWithDuration.length - 1}
                maxDurationIndex={maxDurationIndex}
                prevDate={prevDate}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default TaskStatusTable;
