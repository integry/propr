/** Punctuation and openers that read as unfinished when a shortened text ends on them. */
const TRAILING_PUNCTUATION = /[\s.,;:!?…\-–—/\\([{'"`]+$/u;

/**
 * Shortens `text` to at most `max` characters without cutting a word in half.
 * The text is cut at the last whitespace within the first `max` characters
 * (so the `…` still fits), trailing punctuation is dropped, and `…` marks the
 * cut. A single word longer than the limit is
 * the one case that is cut mid-word, since there is no boundary to cut at.
 */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…'.slice(0, Math.max(0, max));
  const prefix = text.slice(0, max);
  const boundary = prefix.search(/\s\S*$/u);
  const head = boundary > 0 ? prefix.slice(0, boundary) : text.slice(0, max - 1);
  return `${head.replace(TRAILING_PUNCTUATION, '') || head}…`;
}
