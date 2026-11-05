/**
 * The columns a run row and its steps share, so a step reads as part of its
 * run on wide timelines: its time sits in the run's tag column (`Run 3  REVIEW`), its label
 * starts where the run's summary does, and its duration ends on the run's.
 *
 *   ●  ▾  Run 3  REVIEW   Found 2 issues  [6]  39 mins ago   3m 00s
 *   │  ├──  11:21:00      Task Queued                        12s
 *
 * BranchSteps uses compact columns below 528px of container width, including narrow desktop
 * panes. Aligned rows spend 268px on the lead inset (48), tag (136), duration
 * (64), two gaps (16) and right padding (4), leaving at least 260px for labels.
 * The desktop split reserves at least 576px for the timeline, including pane
 * padding and scrollbar space. Workspaces below 960px stack the panes instead
 * of squeezing the timeline; phone step rows wrap labels between compact metadata columns.
 */

/** Node box (16px + 4px margin), gap, caret (12px), gap: where the tag column starts. */
export const RUN_LEAD_INSET = 'pl-12';
/** The same inset for a phone's second run line (time, duration, result), so it starts under `Run N`. */
export const RUN_LEAD_INSET_PHONE = 'max-sm:pl-12';
/** `Run N` (3rem) + gap + the compact type badge (5rem). */
export const RUN_TAG_COLUMN = 'w-[8.5rem]';
export const RUN_NUMBER_COLUMN = 'w-12';
/**
 * The least a run's summary keeps before the result, time and duration wrap
 * under it. Small enough that a wide pane keeps every run on one line, even an
 * open fix with its commit; a phone wraps them, leaving the summary the row.
 */
export const RUN_SUMMARY_MIN_WIDTH = 'min-w-[5rem]';
/** The run's start, right-aligned before its duration, so the results before it line up. */
export const RUN_TIME_COLUMN = 'w-[4.75rem]';
/** The duration, right-aligned at the row's end. */
export const RUN_DURATION_COLUMN = 'w-16';
