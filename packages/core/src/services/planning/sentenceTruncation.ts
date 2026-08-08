/** Truncate text to its first two punctuation-terminated sentences. */
export function truncateToSentences(text: string): string {
  const trimmed = text.trim();
  const sentences: string[] = [];
  let sentenceStart = 0;
  for (let index = 0; index < trimmed.length && sentences.length < 2; index++) {
    if (trimmed[index] !== '.' && trimmed[index] !== '!' && trimmed[index] !== '?') continue;
    let sentenceEnd = index + 1;
    while (sentenceEnd < trimmed.length
      && (trimmed[sentenceEnd] === '.' || trimmed[sentenceEnd] === '!' || trimmed[sentenceEnd] === '?')) {
      sentenceEnd++;
    }
    const sentence = trimmed.slice(sentenceStart, sentenceEnd).trim();
    if ([...sentence].some(char => char !== '.' && char !== '!' && char !== '?')) sentences.push(sentence);
    sentenceStart = sentenceEnd;
    index = sentenceEnd - 1;
  }

  if (sentences.length > 0) return sentences.join(' ');

  const maxLength = 200;
  if (trimmed.length <= maxLength) return trimmed;

  const truncated = trimmed.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
}
