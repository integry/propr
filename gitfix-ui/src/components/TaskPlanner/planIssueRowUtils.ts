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
