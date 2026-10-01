/**
 * One ledger row per task group.
 *
 * The task list used to unroll every run of a pull request as its own nested
 * row under the newest one, so a single busy PR filled the screen and the page
 * boundary in the footer stopped meaning anything. A group is now one row: the
 * newest run carries the status, agent, duration and score, and the runs before
 * it are rolled up behind `↳ N earlier runs`.
 *
 * Titles are written for GitHub, not for a ledger: `Ultrafix PR #2664: [2659 by
 * GPT-6 Astra] Stop work…` repeats the PR number that is already on the row as
 * a chip and carries the model tag in front of what the work is about. Both are
 * dropped, the workflow verb becomes the row's type, and a title that says
 * nothing (`Update`, `Followup: Update 3`) is never used to name the row.
 */

import { trustedPreviewMedia } from '@propr/shared';
import { splitWorkTitle } from '../Dashboard/workTitle';
import type { Task, TaskGroup } from './types';

export interface TaskRunView {
  task: Task;
  /** Workflow type for the badge (`Fix`, `Review`, `Implement`), or null. */
  type: string | null;
  /** What this run changed. Never a repeat of the row title, never `Update`. */
  delta: string;
  previewCount: number;
}

export interface TaskRowView {
  key: string;
  task: Task;
  repository: string;
  /** The entity the row is about: the PR or issue title, sanitized. */
  title: string;
  type: string | null;
  /** The newest run's own summary, when it says more than the title. */
  detail: string | null;
  previewCount: number;
  earlierRuns: TaskRunView[];
}

/** Model tags anywhere in a title: `[2659 by GPT-6 Astra]`, `[Fix by Claude Opus 4.6]`. */
const MODEL_TAG = /\s*\[(?:\d+|Goal|Fix|Review|Follow-?up|Ultrafix|Merge)\s+by\s+[^\]]+\]\s*/gi;

/** A leading entity reference the row already shows as a chip: `PR #2664:`, `Issue #12 -`, `#12:`. */
const LEADING_REFERENCE = /^(?:(?:PR|Pull request|Issue)\s*)?#\d+\s*[:\-–—]\s*/i;

/** Titles that name no work at all. */
const GENERIC_TITLE = /^(?:updates?|follow-?up|changes?|task|untitled(?: task| pull request)?)(?:\s+#?\d+)?\.?$/i;

/** Backend placeholders written before a run has produced anything. */
const PLACEHOLDER_SUBTITLE = /^Preparing a PR\b/i;

const isMeaningful = (text: string | null | undefined): text is string =>
  Boolean(text) && !GENERIC_TITLE.test(text!.trim());

/** Strips workflow prefixes, duplicate entity references and model tags from a title. */
export function sanitizeTaskTitle(raw: string | null | undefined): { type: string | null; title: string | null } {
  const work = splitWorkTitle(raw);
  const title = (work.title ?? '')
    .replace(MODEL_TAG, ' ')
    .replace(LEADING_REFERENCE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { type: work.type, title: title || null };
}

function cleanSubtitle(subtitle: string | null | undefined): string | null {
  const text = sanitizeTaskTitle(subtitle).title;
  if (!text || PLACEHOLDER_SUBTITLE.test(text) || !isMeaningful(text)) return null;
  return text;
}

export function previewCount(task: Task): number {
  return trustedPreviewMedia(task.previewMedia, 100).length;
}

/**
 * The row title is the newest meaningful title in the group. A legacy follow-up
 * is titled `Followup: Update 3`, so the group falls back to an older run (the
 * one that opened the issue or PR) and then to a run summary before giving up.
 */
function entityTitle(tasks: Task[]): string {
  for (const task of tasks) {
    const { title } = sanitizeTaskTitle(task.title);
    if (isMeaningful(title)) return title;
  }
  for (const task of tasks) {
    const subtitle = cleanSubtitle(task.subtitle);
    if (subtitle) return subtitle;
  }
  return 'Untitled task';
}

/** What a run changed, or its type when it recorded nothing more specific. */
function runDelta(task: Task, rowTitle: string): { type: string | null; delta: string | null } {
  const { type, title } = sanitizeTaskTitle(task.title);
  const subtitle = cleanSubtitle(task.subtitle);
  if (subtitle && subtitle !== rowTitle) return { type, delta: subtitle };
  if (isMeaningful(title) && title !== rowTitle) return { type, delta: title };
  return { type, delta: null };
}

export function buildTaskRow(group: TaskGroup): TaskRowView {
  const [task, ...earlier] = group.tasks;
  const title = entityTitle(group.tasks);
  const newest = runDelta(task, title);
  return {
    key: group.key,
    task,
    repository: `${group.repoOwner}/${group.repoName}`,
    title,
    type: newest.type,
    detail: newest.delta,
    previewCount: previewCount(task),
    earlierRuns: earlier.map(run => {
      const { type, delta } = runDelta(run, title);
      return { task: run, type, delta: delta ?? `${type ?? 'Task'} run`, previewCount: previewCount(run) };
    }),
  };
}

export const pluralize = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
