/**
 * The readable log's entry layout. From `sm` up an entry is two columns: a 100px gutter (icon,
 * label, time) beside its content. On a phone that gutter would take a third of the width, so the
 * entry is one column: the gutter becomes a single line above the content, which keeps the full width.
 */
export const LOG_ENTRY_ROW = 'flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3';

export const LOG_ENTRY_GUTTER = 'flex min-w-0 flex-wrap items-center gap-x-2 sm:w-[100px] sm:flex-shrink-0 sm:flex-col sm:flex-nowrap sm:items-start sm:gap-x-0';

/** A gutter line under the label on a wide screen (time, todo); beside it on a phone. */
export const LOG_ENTRY_GUTTER_DETAIL = 'sm:mt-0.5 sm:ml-[18px]';

// The entry's first line on the right is 14px text on `leading-relaxed`, i.e. a 1.4219rem line box.
// The gutter's label row claims exactly that box and centres in it, so `ACTION` and the first line of
// the entry start on the same horizontal line instead of the label floating a couple of pixels above.
export const GUTTER_LABEL_ROW = 'flex min-h-[1.4219rem] items-center gap-1.5';
