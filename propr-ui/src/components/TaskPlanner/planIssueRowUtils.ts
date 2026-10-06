import { MODEL_INFO_MAP } from '../../config/modelDefinitions';

export const getModelName = (modelId: string | null): string => {
  if (!modelId) return '';
  const modelInfo = MODEL_INFO_MAP[modelId];
  return modelInfo?.name || modelId;
};

export const getContainerClassName = (isMerged: boolean): string =>
  isMerged ? 'bg-slate-50/60' : 'bg-white hover:bg-slate-50/60 transition-colors';

export const getTitleClassName = (isMerged: boolean): string =>
  isMerged ? 'text-slate-500' : 'text-slate-800';

export const getImplementButtonClassName = (implementing: boolean, hasAgent: boolean, isFirstPending: boolean): string => {
  if (implementing || !hasAgent) {
    return 'bg-gray-100 text-gray-400 cursor-not-allowed';
  }
  if (!isFirstPending) {
    // Cautionary state: Amber outline button for dependency-blocked but clickable state
    return 'bg-white border border-amber-400 text-amber-700 hover:bg-amber-50';
  }
  return 'bg-primary-600 text-white hover:bg-primary-700';
};

export const getImplementButtonTitle = (hasAgent: boolean, isFirstPending: boolean): string => {
  if (!hasAgent) return 'Select an agent first';
  if (!isFirstPending) return 'Previous tasks not yet merged - click to implement anyway';
  return 'Start AI implementation';
};
