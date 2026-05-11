export const PROMPT_SAVE_DEBOUNCE = 1000;

export function truncateToSentences(text: string): string {
  const trimmed = text.trim();
  const sentencePattern = /[^.!?]+[.!?]+/g;
  const sentences: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = sentencePattern.exec(trimmed)) !== null && sentences.length < 2) {
    sentences.push(match[0].trim());
  }

  if (sentences.length > 0) return sentences.join(' ');
  if (trimmed.length <= 100) return trimmed;

  const truncated = trimmed.slice(0, 100);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? `${truncated.slice(0, lastSpace)}...` : `${truncated}...`;
}
