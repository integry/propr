import { HistoryItem, TaskInfo } from './types';
import { formatModelName } from './utils';

export interface HistoryDerivedData {
  historyItemWithPaths: HistoryItem | undefined;
  currentStatus: string;
  modelName: string;
  prInfo: { url?: string; number?: number } | undefined;
  isTaskActive: boolean;
}

export const getHistoryDerivedData = (history: HistoryItem[], taskInfo: TaskInfo | null): HistoryDerivedData => {
  const historyItemWithPaths = history.find(item => item.promptPath || item.logsPath);
  const currentStatus = history[history.length - 1]?.state?.toUpperCase() || '';
  const routedItem = [...history].reverse().find(item => item.metadata?.syntheticRouting?.virtualModel);
  const modelItem = history.find(item => item.metadata?.model);
  // Task-list/header identity stays virtual; physical execution is shown on the
  // attempt rows in task details.
  const modelName = formatModelName(
    routedItem?.metadata?.syntheticRouting?.virtualModel
      || modelItem?.metadata?.model
      || taskInfo?.modelName,
  );
  
  const completedStep = [...history].reverse().find(item => {
    const state = item.state?.toUpperCase();
    const hasPr = item.metadata?.pr || item.metadata?.pullRequest;
    return (state === 'COMPLETED' || state === 'POST_PROCESSING') && hasPr;
  });
  
  const prInfo = completedStep?.metadata?.pr || completedStep?.metadata?.pullRequest;
  const isTaskActive = !['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentStatus);

  return {
    historyItemWithPaths,
    currentStatus,
    modelName,
    prInfo,
    isTaskActive
  };
};
