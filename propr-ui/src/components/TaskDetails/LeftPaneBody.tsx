import React from 'react';
import TaskStatusTable from './TaskStatusTable';
import ExecutionRail from './ExecutionRail';
import LiveFileChips from './LiveFileChips';
import type { HistoryItem, TaskInfo, LiveDetails } from './types';

interface LeftPaneBodyProps {
  history: HistoryItem[];
  taskInfo: TaskInfo | null | undefined;
  liveDetails: LiveDetails;
  currentStatus: string;
  prInfo: { url?: string; number?: number } | undefined;
  consumedReviewCommentIds: number[] | undefined;
  taskId: string | undefined;
  isTaskActive: boolean;
  onTodoHover: (id: string | null) => void;
}

const LeftPaneBody: React.FC<LeftPaneBodyProps> = ({
  history,
  taskInfo,
  liveDetails,
  currentStatus,
  prInfo,
  consumedReviewCommentIds,
  taskId,
  isTaskActive,
  onTodoHover,
}) => {
  return (
    <div className="p-3 lg:p-4 space-y-2">
      <TaskStatusTable history={history} compact={true} commandMode={taskInfo?.commandMode} />

      {taskInfo?.commandMode === 'review' && currentStatus === 'COMPLETED' && !prInfo && (
        <div className="bg-indigo-50 border border-indigo-100 rounded-md px-3 py-2 text-xs text-indigo-700">
          This was a review-only run — no file changes or PR expected.
        </div>
      )}
      {consumedReviewCommentIds && consumedReviewCommentIds.length > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-md px-3 py-2 text-xs text-amber-700">
          Addressed {consumedReviewCommentIds.length} review comment{consumedReviewCommentIds.length > 1 ? 's' : ''}{' '}
          <span className="font-mono text-[10px] text-amber-600">
            (IDs: {consumedReviewCommentIds.join(', ')})
          </span>
        </div>
      )}

      <ExecutionRail
        liveDetails={liveDetails}
        history={history}
        onTodoHover={onTodoHover}
      />

      {taskId && history.length > 0 && (
        <LiveFileChips
          taskId={taskId}
          isActive={isTaskActive}
        />
      )}
    </div>
  );
};

export default LeftPaneBody;
