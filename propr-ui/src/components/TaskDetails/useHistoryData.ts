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
  // History is oldest first; after an automatic retry the header opens the latest execution, while the timeline keeps each attempt's own.
  const historyItemWithPaths = [...history].reverse().find(item => item.promptPath || item.logsPath);
  const currentStatus = history[history.length - 1]?.state?.toUpperCase() || '';
  const routedItem = [...history].reverse().find(item => item.metadata?.syntheticRouting?.virtualModel);
  const modelItem = [...history].reverse().find(item => item.metadata?.model);
  // The API reconciles task identity with persisted executions, including records
  // without a matching history row. Synthetic identities remain virtual.
  const modelName = formatModelName(
    routedItem?.metadata?.syntheticRouting?.virtualModel
      || taskInfo?.modelName
      || modelItem?.metadata?.model,
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
