import { useMemo } from 'react';
import type { HistoryItem, TaskInfo, LiveDetails } from './types';

export function useTotalDuration(history: HistoryItem[] | null) {
  return useMemo(() => {
    if (!history || history.length === 0) return null;
    const firstTimestamp = history[0]?.timestamp;
    const lastTimestamp = history[history.length - 1]?.timestamp;
    if (!firstTimestamp || !lastTimestamp) return null;
    return new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime();
  }, [history]);
}

export function useCommitInfo(history: HistoryItem[] | null, taskInfo: TaskInfo | null | undefined) {
  return useMemo(() => {
    if (!history || history.length === 0 || !taskInfo) return undefined;

    const historyWithCommit = history.find(
      item => item.metadata?.commitResult?.commitHash
    );

    if (!historyWithCommit?.metadata?.commitResult?.commitHash) return undefined;

    const commitHash = historyWithCommit.metadata.commitResult.commitHash;
    const shortHash = commitHash.substring(0, 7);
    const { repoOwner, repoName } = taskInfo;

    if (!repoOwner || !repoName) return undefined;

    const url = `https://github.com/${repoOwner}/${repoName}/commit/${commitHash}`;

    return { shortHash, url };
  }, [history, taskInfo]);
}

export function useConsumedReviewCommentIds(history: HistoryItem[] | null) {
  return useMemo(() => {
    if (!history || history.length === 0) return undefined;
    const historyWithIds = history.find(
      item => item.metadata?.consumedReviewCommentIds?.length
    );
    return historyWithIds?.metadata?.consumedReviewCommentIds;
  }, [history]);
}

export function useTokenUsage(liveDetails: LiveDetails, history: HistoryItem[] | null) {
  return useMemo(() => {
    if (liveDetails?.tokenUsage) {
      return liveDetails.tokenUsage;
    }

    if (!history || history.length === 0) return undefined;

    const historyWithTokens = history.find(
      item => item.metadata?.tokenUsage
    );

    return historyWithTokens?.metadata?.tokenUsage;
  }, [liveDetails, history]);
}
