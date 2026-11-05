import { TaskInfo } from './types';
import { sanitizeTaskTitle } from '../TaskList/rowModel';

export const getSubtitle = (taskInfo: TaskInfo): string => {
  if (taskInfo.subtitle) return taskInfo.subtitle;
  if (taskInfo.type === 'pr-comment') {
    return `Follow-up changes for PR #${taskInfo.number}`;
  }
  return `Initial implementation for Issue #${taskInfo.number}`;
};

/**
 * The heading reads like the task list's row: the same sanitizer drops the
 * workflow verb (shown as a badge), the `PR #2664:` the context strip already
 * links, and the `[2659 by GPT-6 Astra]` model tag.
 */
export const getDisplayTitle = (title: string | undefined) => {
  const { title: clean, fullTitle } = sanitizeTaskTitle(title);
  return { text: clean ?? title, tooltip: fullTitle ?? title };
};
