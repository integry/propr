export interface SummarizationBatchLimitOverride {
  maxBatchTokens: number;
  maxItemsPerBatch: number;
}

export const MODEL_SUMMARIZATION_LIMIT_OVERRIDES: Record<string, SummarizationBatchLimitOverride> = {
  // Observed in worker logs returning empty output on ~58k-63k token JSON batches.
  'gpt-oss-120b': {
    maxBatchTokens: 20_000,
    maxItemsPerBatch: 5
  }
};

export function getSummarizationBatchLimitOverride(modelId: string): SummarizationBatchLimitOverride | undefined {
  const normalizedModelId = modelId.toLowerCase();
  return Object.entries(MODEL_SUMMARIZATION_LIMIT_OVERRIDES)
    .find(([modelKey]) => normalizedModelId.includes(modelKey.toLowerCase()))?.[1];
}
