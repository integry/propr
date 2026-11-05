import { getModelInfoWithAntigravityCompatibility } from '@propr/shared';
import { useInstanceDefaultModel } from './useInstanceDefaultModel';

/**
 * The context window of a planner model value (`agent:model` or a bare model ID), mirroring the
 * server's `getModelDisplayInfo`. Undefined when the model is unknown to the shared catalog.
 */
export function getModelMaxContextTokens(modelValue: string | null | undefined): number | undefined {
  const trimmed = modelValue?.trim();
  if (!trimmed) return undefined;
  const colonIdx = trimmed.indexOf(':');
  const modelId = colonIdx >= 0 ? trimmed.substring(colonIdx + 1) : trimmed;
  return getModelInfoWithAntigravityCompatibility(modelId)?.maxTokens;
}

/**
 * The context window of the model the planner will generate with: the explicit selection, else the
 * instance default. Lets the context scope estimate use the real window before the preview returns;
 * `fallback` (the preview's window) covers models missing from the shared catalog.
 */
export function useSelectedModelMaxTokens(generationModel: string | null, fallback?: number): number | undefined {
  const instanceDefaultModel = useInstanceDefaultModel(!generationModel);
  return getModelMaxContextTokens(generationModel || instanceDefaultModel) ?? fallback;
}
