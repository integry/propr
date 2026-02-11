import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

export const getModelName = (modelId: string | null): string => {
  if (!modelId) return '';
  const modelInfo = MODEL_INFO_MAP[modelId];
  return modelInfo?.name || modelId;
};

export const getContainerClassName = (isMerged: boolean): string =>
  isMerged ? 'bg-gray-50 border-gray-200' : 'bg-white border-gray-200';

export const getTitleClassName = (isMerged: boolean): string =>
  isMerged ? 'text-gray-500' : 'text-gray-600';

export const getImplementButtonClassName = (implementing: boolean, hasAgent: boolean, isFirstPending: boolean): string => {
  if (implementing || !hasAgent) {
    return 'bg-gray-100 text-gray-400 cursor-not-allowed';
  }
  if (!isFirstPending) {
    return 'bg-gray-200 text-gray-500 hover:bg-gray-300 border border-gray-300';
  }
  return 'bg-primary-600 text-white hover:bg-primary-700';
};

export const getImplementButtonTitle = (hasAgent: boolean, isFirstPending: boolean): string => {
  if (!hasAgent) return 'Select an agent first';
  if (!isFirstPending) return 'Previous tasks not yet merged - click to implement anyway';
  return 'Start AI implementation';
};
