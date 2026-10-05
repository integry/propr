/**
 * The columns a run row and its steps share, so a step reads as part of its
 * run: its time sits in the run's tag column (`Run 3  REVIEW`), its label
 * starts where the run's summary does, and its duration ends on the run's.
 *
 *   ●  ▾  Run 3  REVIEW   Found 2 issues  [6]  39 mins ago   3m 00s
 *   │  ├──  11:21:00      Task Queued                        12s
 */

/** Node box (16px + 4px margin), gap, caret (12px), gap: where the tag column starts. */
export const RUN_LEAD_INSET = 'pl-12';
/** `Run N` (3rem) + gap + the compact type badge (5rem). */
export const RUN_TAG_COLUMN = 'w-[8.5rem]';
export const RUN_NUMBER_COLUMN = 'w-12';
/** The run's start, right-aligned before its duration, so the results before it line up. */
export const RUN_TIME_COLUMN = 'w-[4.75rem]';
/** The duration, right-aligned at the row's end. */
export const RUN_DURATION_COLUMN = 'w-16';
