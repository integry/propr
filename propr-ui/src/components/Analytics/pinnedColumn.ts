/** Pinned first column of a `HorizontalScrollTable`. */

/**
 * Classes for a cell of the pinned first column. It needs its own opaque
 * background, so a row tinted under it passes its tint in `background`.
 */
export const pinnedColumn = (background = 'bg-white'): string =>
  `sticky left-0 z-10 ${background} group-data-[scrolled=true]/scroll:shadow-[6px_0_6px_-6px_rgba(15,23,42,0.25)]`;

export const PINNED_COLUMN = pinnedColumn();
