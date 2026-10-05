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
  /**
   * How the run on screen went: its own model, runtime and consumption, so an
   * earlier run opened from the timeline shows what it cost, not the newest's.
   */
  runStripProps: Pick<TaskHeaderView['contextStripProps'], 'taskInfo' | 'modelName' | 'duration' | 'tokenUsage' | 'usageMetricRecords' | 'synthetic'>;
  /** The run on screen: how it ended, and when it last did anything. */
  runState: { status: string; isActive: boolean; lastActivity?: string };
  /**
   * The run open below the header when it is not the newest, with the newest
   * beside it, and whether the newest is still working (its Stop stays in the header).
   */
  inspection: { run: TaskRunEntry; head: TaskRunEntry; headActive: boolean } | null;
  /** The run on screen and how many the task has, when it has more than one. */
  headerRun?: { number: number; count: number };
}

/** The run line's account of the run on screen, read from that run's own history. */
function describeRunOnScreen(own: TaskHeadSummary, derived: ReturnType<typeof getHistoryDerivedData>, duration: number | null) {
  return {
    runStripProps: {
      taskInfo: own.taskInfo,
      modelName: derived.modelName,
      duration,
      tokenUsage: pickTokenUsage(own.tokenUsage, own.history),
      usageMetricRecords: own.usageMetricRecords,
      synthetic: own.history.some(item => item.metadata?.syntheticRouting !== undefined),
    },
    runState: {
      status: derived.currentStatus,
      isActive: derived.isTaskActive,
      lastActivity: own.history[own.history.length - 1]?.timestamp,
    },
  };
}

/** Which run the run line names: the one on screen, out of the newest's number. */
function headerRunOf(runs: TaskRunEntry[] | undefined, taskId: string | undefined) {
  const shown = runs && runs.length > 1 ? runs.find(entry => entry.task.id === taskId) : undefined;
  return shown && runs ? { number: shown.number, count: runs[runs.length - 1].number } : undefined;
}

/**
 * What the header says. Its first tier is the task, which is its newest run:
 * when the timeline opens an earlier run, it keeps the newest run's status and
 * Stop, read separately. Its run line follows the run on screen, so an earlier
 * run shows its own model, runtime and consumption. The run on screen
 * describes the task too until the newest run has been read.
 */
export function useTaskHeaderView(taskId: string | undefined, runs: TaskRunEntry[] | undefined, own: TaskHeadSummary): TaskHeaderView {
  const head = runs && runs.length > 1 ? runs[runs.length - 1] : undefined;
  const run = head && head.task.id !== taskId ? runs?.find(entry => entry.task.id === taskId) : undefined;
  // The list's account of the newest run: when it changes, e.g. a finished run is started again, the header reads it again.
  const headListState = head ? [head.task.status, head.task.processedAt, head.task.completedAt].join('|') : undefined;
  const headSummary = useTaskHeadSummary(run ? head?.task.id : undefined, headListState);
  const source = headSummary && headSummary.history.length > 0 ? headSummary : own;
  const duration = useTotalDuration(source.history);
  const commitInfo = useCommitInfo(source.history, source.taskInfo);
  const runDuration = useTotalDuration(own.history);

  // Remember the newest run as shown, so opening an earlier one keeps the header steady.
  const viewingHead = Boolean(head && head.task.id === taskId && own.history.length > 0);
  useEffect(() => {
    if (viewingHead && taskId) rememberTaskHead(taskId, own);
  }, [viewingHead, taskId, own]);

  const derived = getHistoryDerivedData(source.history, source.taskInfo);
  const runDerived = source === own ? derived : getHistoryDerivedData(own.history, own.taskInfo);
  // Until the newest run's history is read, the list's account of it decides.
  const headActive = source === headSummary
    ? derived.isTaskActive
    : head?.outcome === 'active' || head?.outcome === 'waiting';
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
    ...describeRunOnScreen(own, runDerived, runDuration),
    inspection: run && head ? { run, head, headActive } : null,
    headerRun: headerRunOf(runs, taskId),
  };
}
