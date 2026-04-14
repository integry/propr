import { MODEL_INFO_MAP } from '../config/modelDefinitions';

interface ModelDisplayNameOptions {
  compactGemini?: boolean;
}

const GEMINI_PREFIX = 'gemini-';

function toTitleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function formatGeminiModelVariant(modelId: string): string {
  if (!modelId.startsWith(GEMINI_PREFIX)) return modelId;

  return modelId
    .slice(GEMINI_PREFIX.length)
    .split('-')
    .filter(Boolean)
    .map(part => /^\d+(\.\d+)*$/.test(part) ? part : toTitleCase(part))
    .join(' ');
}

export function getModelDisplayName(modelId: string, options: ModelDisplayNameOptions = {}): string {
  const modelInfo = MODEL_INFO_MAP[modelId];

  if (options.compactGemini && modelId.startsWith(GEMINI_PREFIX)) {
    return modelInfo?.name.replace(/^Gemini\s+/i, '') || formatGeminiModelVariant(modelId);
  }

  return modelInfo?.name || modelId;
}
