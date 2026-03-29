import React from 'react';

/** Progress state for issue creation via WebSocket */
export interface IssueCreationProgress {
  status: 'idle' | 'in_progress' | 'completed' | 'failed';
  createdCount: number;
  totalCount: number;
  failedCount: number;
  lastCreatedIssue?: { number: number; url: string; title: string };
  error?: string;
}

/** Data payload for execution step updates */
export interface ExecutionStepData {
  createdCount?: number;
  totalCount?: number;
  failedCount?: number;
  lastCreatedIssue?: { number: number; url: string; title: string };
  error?: string;
}

export const IDLE_PROGRESS: IssueCreationProgress = { status: 'idle', createdCount: 0, totalCount: 0, failedCount: 0 };

/** Create progress state from execution step data */
export function createProgressState(
  status: IssueCreationProgress['status'],
  data: ExecutionStepData | undefined
): IssueCreationProgress {
  return {
    status,
    createdCount: data?.createdCount ?? 0,
    totalCount: data?.totalCount ?? 0,
    failedCount: data?.failedCount ?? 0,
    lastCreatedIssue: status === 'in_progress' ? data?.lastCreatedIssue : undefined,
    error: status === 'failed' ? (data?.error || 'Issue creation failed') : undefined
  };
}

interface DraftCompletionOptions {
  data: ExecutionStepData | undefined;
  status: 'completed' | 'failed';
  hasHandledCompletionRef: React.MutableRefObject<boolean>;
  fetchIssues: () => Promise<void>;
  onRefresh?: () => void;
  onCreationComplete?: (createdCount: number, failedCount: number) => void;
}

/** Handle completion/failure of draft execution */
export async function handleDraftCompletion(opts: DraftCompletionOptions) {
  await opts.fetchIssues();
  opts.onRefresh?.();
  if (!opts.hasHandledCompletionRef.current) {
    opts.hasHandledCompletionRef.current = true;
    if (opts.status === 'completed') {
      opts.onCreationComplete?.(opts.data?.createdCount ?? 0, opts.data?.failedCount ?? 0);
    }
  }
}
