/** The task's pull request as the task screen reads it: its review scores and where it ended. */
import { useEffect, useState } from 'react';
import { getPullRequestScores, type PullRequestScoresResponse } from '../../api/taskStatsApi';
import type { TaskInfo } from './types';
import type { TaskRunEntry } from '../TaskList/rowModel';

/**
 * The PR a task belongs to: the PR it opened, or the PR a PR follow-up or
 * review ran on. Null for a task with no PR.
 */
export function taskPullRequest(
  taskInfo: TaskInfo | null | undefined,
  prInfo?: { number?: number },
): { repository: string; prNumber: number } | null {
  const prNumber = prInfo?.number ?? (taskInfo?.type === 'pr-comment' ? taskInfo.number : undefined);
  if (!taskInfo?.repoOwner || !taskInfo.repoName || !prNumber) return null;
  return { repository: `${taskInfo.repoOwner}/${taskInfo.repoName}`, prNumber };
}

/** The PR's review scores and merge outcome, or null while loading, after a failed read, or with no PR. */
export function usePullRequestScores(repository: string | undefined, prNumber: number | undefined): PullRequestScoresResponse | null {
  const identity = repository && prNumber ? `${repository}#${prNumber}` : null;
  // Loaded history is keyed by the PR it belongs to, so another PR's scores are never shown under this PR.
  const [loaded, setLoaded] = useState<{ identity: string; history: PullRequestScoresResponse } | null>(null);

  useEffect(() => {
    setLoaded(null);
    if (!identity || !repository || !prNumber) return;
    let active = true;
    getPullRequestScores(repository, prNumber)
      .then(data => { if (active) setLoaded({ identity, history: data }); })
      // Score history is supplementary; a failed read leaves the run notes as they were.
      .catch(error => { console.warn('Failed to load review score history:', error); });
    return () => { active = false; };
  }, [repository, prNumber, identity]);

  return identity && loaded?.identity === identity ? loaded.history : null;
}

/** Where the task's pull request ended: merged, or closed without merging. */
export interface PullRequestOutcome {
  prNumber: number;
  state: 'merged' | 'closed';
  /** When it was merged or closed, if recorded. */
  at: string | null;
}

/**
 * The PR's final state from its score history; null while it is still open, or unknown.
 * Also null while any of the task's runs is still working or queued: a merge or close
 * ends the task, so it is never shown beside a run that has not.
 */
export function pullRequestOutcome(
  prNumber: number,
  history: PullRequestScoresResponse | null,
  runs: TaskRunEntry[] = [],
): PullRequestOutcome | null {
  if (!history?.outcome) return null;
  if (runs.some(run => run.outcome === 'active' || run.outcome === 'waiting')) return null;
  return {
    prNumber,
    state: history.outcome,
    at: history.outcome === 'merged' ? history.merged_at : history.closed_at ?? history.merged_at,
  };
}
