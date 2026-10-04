/**
 * One ledger row per task group.
 *
 * The task list used to unroll every run of a pull request as its own nested
 * row under the newest one, so a single busy PR filled the screen and the page
 * boundary in the footer stopped meaning anything. A group is now one row: the
 * newest run carries the status, agent and duration, and the runs before
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

/** The ledger's columns. Fixed: expanding a row or resizing the list never changes them. */
export const TASK_QUEUE_COLUMNS = ['Task / PR', 'Repo', 'Status', 'Agent', 'Duration', 'Updated'] as const;

/** Expanded runs span TASK / PR through STATUS, keeping each run summary beside its timestamp. */
export const TASK_RUNS_COLUMN_SPAN = 3;

export interface TaskRunView {
  task: Task;
  /**
   * What the run did (`Fix`, `Review`, `Test`), or null when nothing says so.
   * Never `Follow-up`: every earlier run is a follow-up, so the label told nothing.
   */
  type: string | null;
  /**
   * What this run changed. Never a repeat of the row title, never `Update`.
   * A run that recorded no summary states its outcome instead: whether it
   * pushed a commit, why it failed, or that it has not finished.
   */
  delta: string;
  /** False when the run recorded no summary and `delta` is its outcome. */
  summarized: boolean;
  previewCount: number;
}

export interface TaskRowView {
  key: string;
  task: Task;
  /** `owner/name`, for the tooltip and the icon. */
  repository: string;
  /**
   * The name alone, as the row shows it. The repository filter already scopes
   * the list to this instance's repositories, so the owner is the same on every
   * row and only costs the characters that tell repositories apart.
   */
  repositoryName: string;
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

/**
 * Workflow labels that say a run happened, not what it did. A follow-up is
 * named after its summary instead: `Fix the seed test` is a fix.
 */
const GENERIC_TYPES = new Set(['follow-up', 'continue', 'pr comment']);

/** Leading verbs of a run summary, and the action each one names. */
const SUMMARY_ACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/^(?:re-?run|run|test|verify)\b/i, 'Test'],
  [/^(?:fix|fixes|fixed|resolve|resolves|address|addresses|repair|correct|patch|handle)\b/i, 'Fix'],
  [/^(?:review|reviewed|audit)\b/i, 'Review'],
  [/^(?:rebase|merge|merged)\b/i, 'Merge'],
];

/** The action a run took: its workflow type when that is specific, else what its summary leads with. */
function runAction(type: string | null, summary: string | null): string | null {
  if (type && !GENERIC_TYPES.has(type.toLowerCase())) return type;
  if (!summary) return null;
  return SUMMARY_ACTIONS.find(([pattern]) => pattern.test(summary))?.[1] ?? null;
}

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

/** What a run changed and the action that names it, or null when it recorded nothing more specific. */
function runDelta(task: Task, rowTitle: string): { type: string | null; delta: string | null } {
  const { type: workflow, title } = sanitizeTaskTitle(task.title);
  const subtitle = cleanSubtitle(task.subtitle);
  const delta = subtitle && subtitle !== rowTitle ? subtitle
    : isMeaningful(title) && title !== rowTitle ? title
      : null;
  return { type: runAction(workflow, delta), delta };
}

/** One line of a failure reason; stack traces and log dumps stay on the task page. */
const firstLine = (text: string | null | undefined): string | null => text?.trim().split('\n')[0].trim() || null;

/**
 * What an unsummarized run did, from the facts the run recorded. The status
 * pill beside it already names a failure or cancellation, so the text says
 * what came of it rather than repeating the state.
 */
export function runOutcome(task: Task): string {
  switch (task.status) {
    case 'completed':
    case 'merged':
      return task.commitHash
        ? `Pushed commit ${task.commitHash.slice(0, 7)}`
        : 'No code changes: finished without a commit';
    case 'failed':
      return firstLine(task.failedReason) ?? 'Stopped before reporting a result';
    case 'cancelled':
      return task.commitHash ? `Stopped after commit ${task.commitHash.slice(0, 7)}` : 'Stopped before committing changes';
    default:
      return 'No result yet';
  }
}

export function buildTaskRow(group: TaskGroup): TaskRowView {
  const [task, ...earlier] = group.tasks;
  const title = entityTitle(group.tasks);
  const newest = runDelta(task, title);
  return {
    key: group.key,
    task,
    repository: `${group.repoOwner}/${group.repoName}`,
    repositoryName: group.repoName,
    title,
    type: newest.type,
    detail: newest.delta,
    previewCount: previewCount(task),
    earlierRuns: earlier.map(run => {
      const { type, delta } = runDelta(run, title);
      return {
        task: run,
        type,
        delta: delta ?? runOutcome(run),
        summarized: delta !== null,
        previewCount: previewCount(run),
      };
    }),
  };
}

/**
 * Whether the row needs a line under its title. It does for earlier runs or
 * for a newest-run summary; a single run with neither carries its type in
 * front of the title instead, so it stays one line tall.
 */
export const hasRollupLine = (row: TaskRowView): boolean => row.earlierRuns.length > 0 || Boolean(row.detail);

export const pluralize = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
