/**
 * Formats a token count with a consistent unit so current and maximum values read alike:
 * 942496 -> "942k", 1333000 -> "1.33M", 850 -> "850".
 */
export function formatTokenAmount(tokens: number): string {
  const value = Math.max(0, tokens);
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(2))}M`;
  }
  if (value >= 1_000) {
    const thousands = Math.round(value / 1_000);
    return thousands >= 1_000 ? '1M' : `${thousands}k`;
  }
  return `${Math.round(value)}`;
}
