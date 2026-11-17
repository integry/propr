/**
 * The longest task search the API accepts (`GET /api/tasks?search=`). The
 * field stops at this length, so a pasted wall of text never turns into a
 * "Search cannot exceed 500 characters" error.
 */
export const TASK_SEARCH_MAX_LENGTH = 500;
