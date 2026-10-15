import React, { useMemo } from 'react';
import type { RunRevealHistory } from './RunTimeline';
import TaskStatusTable from './TaskStatusTable';
import RunTimeline from './RunTimeline';
import ExecutionRail from './ExecutionRail';
import LiveFileChips from './LiveFileChips';
import ReviewScoreHistory from './ReviewScoreHistory';
import PullRequestOutcomeEntry from './PullRequestOutcomeEntry';
import { pullRequestOutcome, taskPullRequest } from './pullRequestScores';
import { isAutomationReportTask, taskLabelMode } from './taskKind';
import type { PullRequestScoresResponse } from '../../api/taskStatsApi';
import type { HistoryItem, HistoryItemMetadata, TaskInfo, LiveDetails } from './types';
import { RefreshCw } from 'lucide-react';
import type { TaskRunEntry } from '../TaskList/rowModel';

interface LeftPaneBodyProps {
  history: HistoryItem[];
  taskInfo: TaskInfo | null | undefined;
  liveDetails: LiveDetails;
  currentStatus: string;
  prInfo: { url?: string; number?: number } | undefined;
  /** The PR's review scores and outcome, read once by the task screen; null while loading or with no PR. */
  prHistory: PullRequestScoresResponse | null;
  consumedReviewCommentIds: number[] | undefined;
  taskId: string | undefined;
  isTaskActive: boolean;
  onTodoHover: (id: string | null) => void;
  /**
   * Every run of the task, oldest first. With more than one, the timeline is
   * the task's history: a row per run, this run's steps open under its row.
   */
  runs?: TaskRunEntry[];
  revealHistory?: RunRevealHistory;
  /** Opens another run of the task in its place. */
  onSelectRun?: (taskId: string) => void;
}

/** Extract the most informative ultrafix metadata from history entries.
 *  Prefers entries with enriched continuation fields (score, nextAction, stopReason)
 *  over entries that only have the base ultrafixCycle flag. */
function getUltrafixMeta(history: HistoryItem[]): HistoryItemMetadata | null {
  let bestMeta: HistoryItemMetadata | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const meta = history[i].metadata;
    if (!meta?.ultrafixCycle) continue;
    // If this entry has enriched continuation fields, return it immediately
    if (meta.ultrafixScore != null || meta.ultrafixNextAction || meta.ultrafixStopReason) {
      return meta;
    }
    // Otherwise, keep the latest base entry as fallback
    if (!bestMeta) bestMeta = meta;
  }
  return bestMeta;
}

type RunNotesProps = Pick<LeftPaneBodyProps, 'history' | 'taskInfo' | 'currentStatus' | 'prInfo' | 'consumedReviewCommentIds'> & {
  pullRequest: { prNumber: number; history: PullRequestScoresResponse | null } | null;
};

/** What a run recorded beyond its steps: pool routing, the ultrafix loop, review notes. */
const RunNotes: React.FC<RunNotesProps> = ({ history, taskInfo, currentStatus, prInfo, consumedReviewCommentIds, pullRequest }) => {
  const ultrafixMeta = useMemo(() => getUltrafixMeta(history), [history]);
  const routingAttempts = useMemo(
    () => history.flatMap(item => item.metadata?.syntheticRouting ? [item.metadata.syntheticRouting] : []),
    [history],
  );

  return (
    <>
      {routingAttempts.length > 0 && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <div className="font-medium text-slate-900">
            Synthetic {routingAttempts[0].virtualAgentAlias} · {routingAttempts[0].virtualModel}
          </div>
          <div className="mt-1 text-[11px] text-slate-600">
            {routingAttempts.map(attempt => (
              <span key={`${attempt.callId}:${attempt.attemptNumber}`} className="mr-2 inline-block">
                #{attempt.attemptNumber} {attempt.physicalAgentAlias} · {attempt.physicalModel}
              </span>
            ))}
          </div>
        </div>
      )}

      {ultrafixMeta && (
        <div className="bg-violet-50 border border-violet-100 rounded-md px-3 py-2 text-xs text-violet-700 space-y-1">
          <div className="flex items-center gap-1.5 font-medium">
            <RefreshCw className="h-3 w-3" />
            Ultrafix Loop
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
            {ultrafixMeta.ultrafixCycleCount != null && (
              <span>Cycle: <span className="font-semibold">{ultrafixMeta.ultrafixCycleCount}</span>{ultrafixMeta.ultrafixMaxCycles != null && ` / ${ultrafixMeta.ultrafixMaxCycles}`}</span>
            )}
            {ultrafixMeta.ultrafixGoal != null && (
              <span>Goal: <span className="font-semibold">{ultrafixMeta.ultrafixGoal}</span></span>
            )}
            {ultrafixMeta.ultrafixScore != null && (
              <span>Score: <span className="font-semibold">{ultrafixMeta.ultrafixScore}</span></span>
            )}
            {ultrafixMeta.ultrafixNextAction && (
              <span>Next: <span className="font-semibold capitalize">{ultrafixMeta.ultrafixNextAction}</span></span>
            )}
          </div>
          {ultrafixMeta.ultrafixStopReason && (
            <div className="text-[11px] text-violet-600">
              Stopped: {ultrafixMeta.ultrafixStopReason}
            </div>
          )}
        </div>
      )}

      {pullRequest && <ReviewScoreHistory prNumber={pullRequest.prNumber} history={pullRequest.history} variant="standalone" />}

      {taskInfo?.commandMode === 'review' && currentStatus === 'COMPLETED' && !prInfo && (
        <div className="bg-indigo-50 border border-indigo-100 rounded-md px-3 py-2 text-xs text-indigo-700">
          This was a review-only run — no file changes or PR expected.
        </div>
      )}
      {isAutomationReportTask(taskInfo) && currentStatus === 'COMPLETED' && (
        <div className="bg-slate-50 border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-700">
          This automation run wrote a report — no file changes, issue or PR expected.
        </div>
      )}
      {consumedReviewCommentIds && consumedReviewCommentIds.length > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-md px-3 py-2 text-xs text-amber-700">
          Addressed {consumedReviewCommentIds.length} review comment{consumedReviewCommentIds.length > 1 ? 's' : ''}{' '}
          <span className="break-all font-mono text-[10px] text-amber-600">
            (IDs: {consumedReviewCommentIds.join(', ')})
          </span>
        </div>
      )}
    </>
  );
};

const LeftPaneBody: React.FC<LeftPaneBodyProps> = ({
  history,
  taskInfo,
  liveDetails,
  currentStatus,
  prInfo,
  prHistory,
  consumedReviewCommentIds,
  taskId,
  isTaskActive,
  onTodoHover,
  runs,
  revealHistory,
  onSelectRun,
}) => {
  const pr = taskPullRequest(taskInfo, prInfo);
  const timeline = runs && runs.length > 1 && taskId && onSelectRun;
  const outcome = pr ? pullRequestOutcome(pr.prNumber, prHistory, runs) : null;
  const reviewScores = pr && { prNumber: pr.prNumber, history: prHistory };
  const runNotes = (
    <RunNotes
      history={history}
      taskInfo={taskInfo}
      currentStatus={currentStatus}
      prInfo={prInfo}
      consumedReviewCommentIds={consumedReviewCommentIds}
      // On the timeline the scores are a milestone on its trunk instead, after every run.
      pullRequest={timeline ? null : reviewScores}
    />
  );
  // An earlier run's files are named as that run's, so they never read as the live run's.
  const inspectedRun = timeline && runs[runs.length - 1].task.id !== taskId
    ? runs.find(run => run.task.id === taskId)?.number
    : undefined;

  return (
    <div className="p-3 lg:p-4 space-y-2">
      {timeline ? (
        <RunTimeline revealHistory={revealHistory} runs={runs} selectedTaskId={taskId} onSelectRun={onSelectRun} reviewScores={reviewScores} outcome={outcome}>
          <TaskStatusTable history={history} commandMode={taskLabelMode(taskInfo)} variant="branch" />
          <div className="space-y-2 pl-6 pr-1 pt-1 empty:hidden">{runNotes}</div>
        </RunTimeline>
      ) : (
        <>
          <TaskStatusTable history={history} compact={true} commandMode={taskLabelMode(taskInfo)} />
          {runNotes}
          {/* The task's last entry, after its run: where the pull request ended. */}
          {outcome && <PullRequestOutcomeEntry outcome={outcome} variant="standalone" />}
        </>
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
          runNumber={inspectedRun}
        />
      )}
    </div>
  );
};

export default LeftPaneBody;
