import { MODEL_INFO_MAP } from '../config/modelDefinitions';

interface ModelDisplayNameOptions {
  compactGemini?: boolean;
  compactAntigravity?: boolean;
}

const GEMINI_PREFIX = 'gemini-';
const ANTIGRAVITY_PREFIX = 'antigravity-';

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

  if (options.compactAntigravity && modelId.startsWith(ANTIGRAVITY_PREFIX)) {
    return modelInfo?.name.replace(/^Antigravity\s+/i, '') || modelId.slice(ANTIGRAVITY_PREFIX.length);
  }

  if (options.compactGemini && modelId.startsWith(GEMINI_PREFIX)) {
    return modelInfo?.name.replace(/^Gemini\s+/i, '') || formatGeminiModelVariant(modelId);
  }

  return modelInfo?.name || modelId;
}
