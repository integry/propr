import { useEffect } from 'react';
import { getHistoryDerivedData } from './useHistoryData';
import { useCommitInfo, useTotalDuration } from './useDerivedTaskData';
import { pickTokenUsage, rememberTaskHead, useTaskHeadSummary, type TaskHeadSummary } from './useTaskHeadSummary';
import type { TaskRunEntry } from '../TaskList/rowModel';

interface TaskHeaderView {
  headerProps: { taskInfo: TaskHeadSummary['taskInfo']; currentStatus: string };
  contextStripProps: {
    taskInfo: TaskHeadSummary['taskInfo'];
    modelName: string;
    prInfo?: { url?: string; number?: number };
    commitInfo?: { shortHash: string; url: string };
    duration: number | null;
    tokenUsage?: TaskHeadSummary['tokenUsage'];
    usageMetricRecords: TaskHeadSummary['usageMetricRecords'];
    synthetic: boolean;
  };
  /** The run open below the header when it is not the newest, with the newest beside it. */
  inspection: { run: TaskRunEntry; head: TaskRunEntry } | null;
}

/**
 * What the header says: the task, which is its newest run. When the timeline
 * opens an earlier run, the panels below follow that run, but the header keeps
 * the newest run's status, title, runtime and consumption, read separately.
 * The run on screen describes itself until the newest run has been read.
 */
export function useTaskHeaderView(taskId: string | undefined, runs: TaskRunEntry[] | undefined, own: TaskHeadSummary): TaskHeaderView {
  const head = runs && runs.length > 1 ? runs[runs.length - 1] : undefined;
  const run = head && head.task.id !== taskId ? runs?.find(entry => entry.task.id === taskId) : undefined;
  const headSummary = useTaskHeadSummary(run ? head?.task.id : undefined);
  const source = headSummary && headSummary.history.length > 0 ? headSummary : own;
  const duration = useTotalDuration(source.history);
  const commitInfo = useCommitInfo(source.history, source.taskInfo);

  // Remember the newest run as shown, so opening an earlier one keeps the header steady.
  const viewingHead = Boolean(head && head.task.id === taskId && own.history.length > 0);
  useEffect(() => {
    if (viewingHead && taskId) rememberTaskHead(taskId, own);
  }, [viewingHead, taskId, own]);

  const derived = getHistoryDerivedData(source.history, source.taskInfo);
  return {
    headerProps: { taskInfo: source.taskInfo, currentStatus: derived.currentStatus },
    contextStripProps: {
      taskInfo: source.taskInfo,
      modelName: derived.modelName,
      prInfo: derived.prInfo,
      commitInfo,
      duration,
      tokenUsage: pickTokenUsage(source.tokenUsage, source.history),
      usageMetricRecords: source.usageMetricRecords,
      synthetic: source.history.some(item => item.metadata?.syntheticRouting !== undefined),
    },
    inspection: run && head ? { run, head } : null,
  };
}
