/**
 * Splits the text in a tag input into entries to commit and the text that
 * stays in the field. Every comma ends an entry, so a pasted `a,b,c` yields
 * three entries at once.
 *
 * - `final` (Enter) commits the last segment too; otherwise it is still being
 *   typed and stays in the field.
 * - Entries already in `items` stay in the field rather than vanishing, so the
 *   "already in the list" hint can name them.
 */
export function parseTagDraft(
  text: string,
  items: readonly string[],
  final: boolean
): { added: string[]; draft: string } {
  const segments = text.split(',');
  const remainder = final ? '' : segments.pop()!.trimStart();
  const added: string[] = [];
  const duplicates: string[] = [];
  for (const segment of segments) {
    const entry = segment.trim();
    if (!entry || added.includes(entry)) continue;
    if (items.includes(entry)) {
      if (!duplicates.includes(entry)) duplicates.push(entry);
    } else {
      added.push(entry);
    }
  }
  if (duplicates.length === 0) return { added, draft: remainder };
  return { added, draft: final ? duplicates.join(', ') : `${duplicates.join(', ')}, ${remainder}` };
}

/** The first entry in `text` that is already in `items`, if any. */
export function duplicateTagIn(text: string, items: readonly string[]): string | undefined {
  return text.split(',').map(segment => segment.trim()).find(entry => entry && items.includes(entry));
}
