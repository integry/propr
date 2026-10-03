/**
 * Titles stored before word-boundary truncation were cut with a hard
 * `slice(0, 100)`, so some end mid-word (`… so an MCP client can actu`) and
 * the CSS line clamp has no overflow to mark. A title of exactly that length
 * that ends on a letter or digit is treated as cut: it is trimmed back to its
 * last whole word and marked with `…`.
 */
export const LEGACY_TITLE_CUT_LENGTH = 100;

const ENDS_MID_WORD = /[\p{L}\p{N}]$/u;

/** Whether a stored title looks like it was hard-cut at the legacy limit. */
export const isHardCutTitle = (source: string | null | undefined): boolean =>
  typeof source === 'string' && source.length === LEGACY_TITLE_CUT_LENGTH && ENDS_MID_WORD.test(source);

/**
 * Marks a legacy hard-cut title with `…`. `source` is the stored title, which
 * decides whether it was cut; `title` is what the row shows (the stored title
 * after its prefixes are stripped), and is what gets trimmed.
 */
export function ellipsizeHardCutTitle(title: string, source: string = title): string {
  if (!isHardCutTitle(source) || !ENDS_MID_WORD.test(title)) return title;
  const boundary = title.search(/\s\S*$/u);
  const head = boundary > 0 ? title.slice(0, boundary).replace(/[\s.,;:!?\-–—/([{'"`]+$/u, '') : title;
  return `${head || title}…`;
}
