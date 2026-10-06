import { useEffect, useState } from 'react';
import { getTaskHistory } from '../../api/proprApi';
import type { HistoryItem, TaskBudget, TaskInfo, TokenUsage, UsageMetricRecord } from './types';

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
  /** Spend against the run's spend cap, when it has a cap or recorded spend. */
  budget?: TaskBudget | null;
}

interface TaskHistoryResponse {
  history?: HistoryItem[];
  taskInfo?: TaskInfo | null;
  usageMetricRecords?: UsageMetricRecord[];
  budget?: TaskBudget;
}

/** How often the header re-reads a newest run that is still working. */
const REFRESH_MS = 15_000;

/**
 * The newest run as last shown, so moving back through the timeline keeps the
 * header steady instead of blanking it while the newest run is read again.
 */
const summaries = new Map<string, TaskHeadSummary>();

/**
 * The consumption the pane last saw for a newest run, and the time of the
 * newest history entry when it saw it. Once polling stops at the live feed,
 * this count only stands until the history records a newer one.
 */
interface SeenTokenUsage {
  usage: TokenUsage;
  asOf: number;
}

const seenUsage = new Map<string, SeenTokenUsage>();

const entryTime = (item: HistoryItem | undefined): number => {
  const time = item?.timestamp ? Date.parse(item.timestamp) : NaN;
  return Number.isNaN(time) ? 0 : time;
};

const hasTokens = (usage: TokenUsage | null | undefined): usage is TokenUsage =>
  Boolean(usage) && Object.values(usage!).some(value => (value ?? 0) > 0);

/** The run's consumption: the live count while it has one, else the one its history recorded. */
export function pickTokenUsage(live: TokenUsage | null | undefined, history: HistoryItem[] | null | undefined): TokenUsage | undefined {
  if (hasTokens(live)) return live;
  return history?.find(item => hasTokens(item.metadata?.tokenUsage))?.metadata?.tokenUsage ?? undefined;
}

/**
 * The newest run's consumption from a fresh read of its history: the count the
 * pane last saw, unless the history has since recorded a newer one. Usage the
 * history records after that count was seen supersedes it, so the header
 * follows a run that keeps working, and finishes, while an earlier run is open.
 */
export function reconcileTokenUsage(seen: SeenTokenUsage | undefined, history: HistoryItem[]): TokenUsage | undefined {
  const recorded = [...history].reverse().find(item => hasTokens(item.metadata?.tokenUsage));
  if (seen && hasTokens(seen.usage) && (!recorded || entryTime(recorded) <= seen.asOf)) return seen.usage;
  return recorded?.metadata?.tokenUsage ?? undefined;
}

/** Remembers the newest run of a task as the pane shows it. */
export function rememberTaskHead(taskId: string, summary: TaskHeadSummary): void {
  summaries.set(taskId, summary);
  if (hasTokens(summary.tokenUsage)) {
    seenUsage.set(taskId, { usage: summary.tokenUsage, asOf: Math.max(0, ...summary.history.map(entryTime)) });
  } else {
    seenUsage.delete(taskId);
  }
}

const isFinished = (summary: TaskHeadSummary | null) =>
  ['COMPLETED', 'FAILED', 'CANCELLED'].includes(summary?.history.at(-1)?.state?.toUpperCase() ?? '');

/**
 * Reads the newest run of the task while an earlier one is open in the pane,
 * and keeps reading it while it works. Polling stops once the run finishes,
 * but a follow-up can start the same run id again, so the run is read again
 * whenever `listState`, the list's account of that run, changes. Null when no
 * earlier run is open.
 */
export function useTaskHeadSummary(headTaskId: string | undefined, listState?: string): TaskHeadSummary | null {
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
          budget: data.budget ?? null,
          // A live count seen earlier stands only until the history records a newer one.
          tokenUsage: reconcileTokenUsage(seenUsage.get(headTaskId), history),
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
  }, [headTaskId, finished, listState]);

  return headTaskId ? summary : null;
}
