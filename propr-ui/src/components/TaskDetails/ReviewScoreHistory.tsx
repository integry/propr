/**
 * The pull request's persisted review scores, oldest first: a sparkline over
 * the 1–10 scale and one line per score (cycle, score, reviewer, head).
 *
 * Renders nothing until the PR has at least one score, so tasks on unscored
 * PRs keep their run notes unchanged.
 */

import React, { useEffect, useState } from 'react';
import { getPullRequestScores, type PullRequestScoresResponse } from '../../api/taskStatsApi';
import { formatModelName } from '../../utils/modelDisplay';
import { SPARKLINE_HEIGHT as HEIGHT, SPARKLINE_WIDTH as WIDTH, sparklinePoints } from './reviewScoreSparkline';
import type { TaskInfo } from './types';

interface ReviewScoreHistoryProps {
  repository: string;
  prNumber: number;
}


const outcomeLabel: Record<'merged' | 'closed', string> = { merged: 'Merged', closed: 'Closed unmerged' };

const ReviewScoreHistory: React.FC<ReviewScoreHistoryProps> = ({ repository, prNumber }) => {
  const [history, setHistory] = useState<PullRequestScoresResponse | null>(null);

  useEffect(() => {
    let active = true;
    getPullRequestScores(repository, prNumber)
      .then(data => { if (active) setHistory(data); })
      // Score history is supplementary; a failed read leaves the run notes as they were.
      .catch(error => { console.warn('Failed to load review score history:', error); });
    return () => { active = false; };
  }, [repository, prNumber]);

  if (!history || history.scores.length === 0) return null;
  const scores = history.scores.map(entry => entry.score);
  const points = sparklinePoints(scores);

  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700" data-testid="review-score-history">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-900">Review scores · PR #{prNumber}</span>
        <svg
          width={WIDTH}
          height={HEIGHT}
          viewBox={`-3 -3 ${WIDTH + 6} ${HEIGHT + 6}`}
          role="img"
          aria-label={`Review scores: ${scores.join(', ')} out of 10`}
          className="flex-none"
        >
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-teal-600" />
          {points.split(' ').map(point => {
            const [cx, cy] = point.split(',');
            return <circle key={point} cx={cx} cy={cy} r={2} className="fill-teal-600" />;
          })}
        </svg>
      </div>
      <ol className="mt-1 space-y-0.5 text-[11px]">
        {history.scores.map(entry => (
          <li key={`${entry.task_id}:${entry.created_at}:${entry.reviewer_model}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="w-14 flex-none text-slate-500">
              {entry.source === 'ultrafix' && entry.cycle_number !== null ? `Cycle ${entry.cycle_number}` : 'Review'}
            </span>
            <span className="font-semibold tabular-nums text-slate-900">{entry.score}/10</span>
            {entry.reviewer_model && <span className="text-slate-500">{formatModelName(entry.reviewer_model)}</span>}
            {entry.head_sha && <span className="font-mono text-[10px] text-slate-400">{entry.head_sha.slice(0, 7)}</span>}
            <time className="ml-auto text-slate-400" dateTime={entry.created_at}>
              {new Date(entry.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </time>
          </li>
        ))}
      </ol>
      {history.outcome && (
        <div className="mt-1 text-[11px] text-slate-500">{outcomeLabel[history.outcome]}</div>
      )}
    </div>
  );
};

/**
 * The score history of the PR a task belongs to: the PR it opened, or the PR a
 * PR follow-up or review ran on. Nothing for a task with no PR.
 */
export const TaskReviewScoreHistory: React.FC<{ taskInfo: TaskInfo | null | undefined; prInfo?: { number?: number } }> = ({
  taskInfo, prInfo,
}) => {
  const prNumber = prInfo?.number ?? (taskInfo?.type === 'pr-comment' ? taskInfo.number : undefined);
  if (!taskInfo?.repoOwner || !taskInfo.repoName || !prNumber) return null;
  return <ReviewScoreHistory repository={`${taskInfo.repoOwner}/${taskInfo.repoName}`} prNumber={prNumber} />;
};

export default ReviewScoreHistory;
