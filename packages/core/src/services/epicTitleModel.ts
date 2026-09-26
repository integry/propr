/**
 * Epic titles are summaries, so always use the configured summarization model.
 * Never silently select a provider-specific model.
 */
export function resolveEpicTitleGenerationModel(
  summarizationModel?: string,
): string {
  const model = summarizationModel?.trim();
  if (!model) {
    throw new Error('No model configured for epic title generation. Select a Summarization Model in Settings.');
  }
  return model;
}
