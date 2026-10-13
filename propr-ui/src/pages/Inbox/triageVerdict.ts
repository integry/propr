import type { Notification } from '@propr/shared';
import type { FileChange } from '../../api/fileChangesApi';
import { notificationFindingReference, notificationReviewOutcome } from '../inboxUtils';

/** The verdict card shows the few broken lines, not the change: the workbench in /tasks has the rest. */
export const MAX_TRIAGE_DIFF_FILES = 2;
export const MAX_TRIAGE_DIFF_LINES = 12;

export interface TriageFinding {
  /** 1-based position in the reviewer's list. */
  index: number;
  /** The `path:line` the finding leads with, when it names one. */
  reference: string | null;
  text: string;
}

export interface TriageReviewVerdict {
  score: number | null;
  /** The recap's issue count; the recap may list fewer titles than this, never more. */
  issueCount: number;
  findings: TriageFinding[];
}

/** The review's score and enumerated findings, read from the notification itself; no extra request. */
export function reviewFindings(notification: Notification): TriageReviewVerdict {
  const outcome = notificationReviewOutcome(notification);
  if (!outcome) return { score: null, issueCount: 0, findings: [] };
  return {
    score: outcome.score,
    issueCount: Math.max(outcome.issueCount, outcome.findings.length),
    findings: outcome.findings.map((finding, position) => {
      const reference = notificationFindingReference(finding);
      return {
        index: position + 1,
        reference: reference?.reference ?? null,
        text: reference ? reference.text : finding,
      };
    }),
  };
}

/**
 * The run whose commit shows what a review read: a review commits nothing, so
 * its diff is the newest earlier run of the same task that pushed a commit.
 * `runs` is newest first; null when no earlier run pushed one.
 */
export function reviewedRunId(runs: ReadonlyArray<{ id: string; commitHash?: string | null }>, reviewTaskId: string): string | null {
  const index = runs.findIndex(run => run.id === reviewTaskId);
  if (index === -1) return null;
  return runs.slice(index + 1).find(run => run.commitHash)?.id ?? null;
}

/** The task behind a notification, which the diff and `Inspect in Tasks` open; null when none backs it. */
export function triageTaskId(notification: Notification): string | null {
  const { target } = notification;
  if ((target.type === 'review' || target.type === 'task') && target.taskId) return target.taskId;
  const completedTaskId = notification.metadata?.completedImplementationTaskId;
  if (target.type === 'pull_request' && typeof completedTaskId === 'string' && completedTaskId) return completedTaskId;
  return null;
}

export type TriageDiffLineKind = 'added' | 'removed';

export interface TriageDiffFile {
  path: string;
  lines: Array<{ kind: TriageDiffLineKind; text: string }>;
  /** Changed lines left out of the card. */
  hiddenLines: number;
}

export interface TriageDiff {
  files: TriageDiffFile[];
  /** Files left out of the card. */
  hiddenFiles: number;
}

/** A file header line of a unified diff, before its first hunk. */
const DIFF_HEADER = /^(?:diff |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename |Binary files )/;

/**
 * The added and removed lines of a unified diff. Only the lines before the
 * first `@@` hunk are headers, so a removed `-- comment` line (`--- comment`
 * in the diff) is still a change; a diff without hunks drops its leading
 * header lines only, which end at the `+++` file line.
 */
function changedLines(diff: string): TriageDiffFile['lines'] {
  const lines = diff.split('\n');
  const firstHunk = lines.findIndex(line => line.startsWith('@@'));
  let start = firstHunk + 1;
  if (firstHunk === -1) {
    start = 0;
    while (start < lines.length && DIFF_HEADER.test(lines[start])) {
      start += 1;
      if (lines[start - 1].startsWith('+++ ')) break;
    }
  }
  return lines.slice(start).flatMap<TriageDiffFile['lines'][number]>(line => {
    if (line.startsWith('+')) return [{ kind: 'added', text: line.slice(1) }];
    if (line.startsWith('-')) return [{ kind: 'removed', text: line.slice(1) }];
    return [];
  });
}

/** Bounds a task's diff to the first files and changed lines, so the card stays a verdict. */
export function trimDiffForTriage(files: readonly FileChange[]): TriageDiff {
  const withChanges = files
    .map(file => ({ path: file.path, lines: changedLines(file.diff ?? '') }))
    .filter(file => file.lines.length > 0);
  return {
    files: withChanges.slice(0, MAX_TRIAGE_DIFF_FILES).map(file => ({
      path: file.path,
      lines: file.lines.slice(0, MAX_TRIAGE_DIFF_LINES),
      hiddenLines: Math.max(0, file.lines.length - MAX_TRIAGE_DIFF_LINES),
    })),
    hiddenFiles: Math.max(0, withChanges.length - MAX_TRIAGE_DIFF_FILES),
  };
}
