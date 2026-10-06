/**
 * Titles stored before word-boundary truncation were cut with a hard
 * `slice(0, 100)`, so some end mid-word (`… so an MCP client can actu`) and
 * the CSS line clamp has no overflow to mark. A title of exactly that length
 * that ends on a letter or digit may have been cut, but nothing stored says
 * whether it was: a complete title can be 100 characters and end on a whole
 * word too. A word sliced in half (`… with hones…`) reads as a bug, so such a
 * title ends at the last word boundary before the cut and gains a `…`; the
 * tooltip keeps everything that was stored.
 */
export const LEGACY_TITLE_CUT_LENGTH = 100;

const ENDS_MID_WORD = /[\p{L}\p{N}]$/u;

/** Whether a stored title may have been hard-cut at the legacy limit. */
export const isHardCutTitle = (source: string | null | undefined): boolean =>
  typeof source === 'string' && source.length === LEGACY_TITLE_CUT_LENGTH && ENDS_MID_WORD.test(source);

/** The trailing word that may be a fragment, and the separators before it. */
const TRAILING_WORD = /[\s\p{P}\p{S}]*[\p{L}\p{N}]+$/u;

/**
 * Ends a title that may have been hard-cut at the legacy limit on a whole word,
 * marked with `…`. `source` is the stored title, which decides whether it may
 * have been cut; `title` is what the row shows (the stored title after its
 * prefixes are stripped). The last word may be a fragment, so it is dropped;
 * a title that is one word long has nothing else to show and keeps it.
 */
export function ellipsizeHardCutTitle(title: string, source: string = title): string {
  if (!isHardCutTitle(source) || !ENDS_MID_WORD.test(title)) return title;
  const whole = title.replace(TRAILING_WORD, '');
  return `${whole || title}…`;
}
