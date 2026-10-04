import { useEffect, useState } from 'react';
import { getTaskHistory } from '../../api/proprApi';
import type { HistoryItem, TaskInfo, TokenUsage, UsageMetricRecord } from './types';

/**
 * What the pane's header says about a task: its newest run's status, title,
 * runtime and consumption. While an earlier run is open below it, the header
 * still describes the task, so it reads these from the newest run rather than
 * from the run on screen.
 */
export interface TaskHeadSummary {
  history: HistoryItem[];
  taskInfo: TaskInfo | null;
  usageMetricRecords: UsageMetricRecord[];
  tokenUsage?: TokenUsage;
}

interface TaskHistoryResponse {
  history?: HistoryItem[];
  taskInfo?: TaskInfo | null;
  usageMetricRecords?: UsageMetricRecord[];
}

/** How often the header re-reads a newest run that is still working. */
const REFRESH_MS = 15_000;

/**
 * The newest run as last shown, so moving back through the timeline keeps the
 * header steady instead of blanking it while the newest run is read again.
 */
const summaries = new Map<string, TaskHeadSummary>();

const hasTokens = (usage: TokenUsage | null | undefined): usage is TokenUsage =>
  Boolean(usage) && Object.values(usage!).some(value => (value ?? 0) > 0);

/** The run's consumption: the live count while it has one, else the one its history recorded. */
export function pickTokenUsage(live: TokenUsage | null | undefined, history: HistoryItem[] | null | undefined): TokenUsage | undefined {
  if (hasTokens(live)) return live;
  return history?.find(item => hasTokens(item.metadata?.tokenUsage))?.metadata?.tokenUsage ?? undefined;
}

/** Remembers the newest run of a task as the pane shows it. */
export function rememberTaskHead(taskId: string, summary: TaskHeadSummary): void {
  summaries.set(taskId, summary);
}

const isFinished = (summary: TaskHeadSummary | null) =>
  ['COMPLETED', 'FAILED', 'CANCELLED'].includes(summary?.history.at(-1)?.state?.toUpperCase() ?? '');

/**
 * Reads the newest run of the task while an earlier one is open in the pane,
 * and keeps reading it while it works. Null when no earlier run is open.
 */
export function useTaskHeadSummary(headTaskId: string | undefined): TaskHeadSummary | null {
  const [summary, setSummary] = useState<TaskHeadSummary | null>(() => (headTaskId ? summaries.get(headTaskId) ?? null : null));
  const [readFor, setReadFor] = useState(headTaskId);
  if (readFor !== headTaskId) {
    setReadFor(headTaskId);
    setSummary(headTaskId ? summaries.get(headTaskId) ?? null : null);
  }
  const finished = isFinished(summary);

  useEffect(() => {
    if (!headTaskId) return;
    let cancelled = false;
    const read = async () => {
      try {
        const data = await getTaskHistory(headTaskId) as TaskHistoryResponse;
        if (cancelled) return;
        const history = data.history ?? [];
        const next: TaskHeadSummary = {
          history,
          taskInfo: data.taskInfo ?? null,
          usageMetricRecords: data.usageMetricRecords ?? [],
          // A live count read earlier may be newer than the history's.
          tokenUsage: pickTokenUsage(summaries.get(headTaskId)?.tokenUsage, history),
        };
        summaries.set(headTaskId, next);
        setSummary(next);
      } catch (error) {
        // The header keeps the last summary it had; the run on screen is unaffected.
        console.error('Error reading the newest run of the task:', error);
      }
    };
    void read();
    const timer = finished ? undefined : window.setInterval(() => void read(), REFRESH_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [headTaskId, finished]);

  return headTaskId ? summary : null;
}
