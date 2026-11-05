import type { FollowupTarget, TaskInfo } from './types';

/** Label mode for an automation report task; its shared execution states describe a report, not code changes. */
export const AUTOMATION_REPORT_MODE = 'automation-report';

type KindInfo = Pick<TaskInfo, 'taskKind' | 'commandMode'> | null | undefined;

export const isAutomationReportTask = (taskInfo: KindInfo): boolean => taskInfo?.taskKind === 'automation-report';

/** What the task's states are labelled as: its command mode, or the report an automation run writes. */
export const taskLabelMode = (taskInfo: KindInfo): string | undefined =>
  isAutomationReportTask(taskInfo) ? AUTOMATION_REPORT_MODE : taskInfo?.commandMode;

/**
 * An automation report run shares the execution states of an issue run, but
 * it analyses, writes a report and stores it: it changes no files and opens
 * no pull request. Null for other tasks and for states labelled alike
 * (queued, generating, failed, cancelled).
 */
export const reportStepLabel = (stateUpper: string | undefined, labelMode: string | undefined): string | null => {
  if (labelMode !== AUTOMATION_REPORT_MODE) return null;
  switch (stateUpper) {
    case 'PROCESSING': return 'Preparing Analysis';
    case 'CLAUDE_EXECUTION_COMPLETED': return 'Report Generated';
    case 'POST_PROCESSING': return 'Storing Report';
    case 'COMPLETED': return 'Report Ready';
    default: return null;
  }
};

const isThreadNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * Whether a follow-up comment has a GitHub thread to go to: the task's pull
 * request, or its issue or PR number. An automation run's task has neither.
 * The server validates the target again; this only keeps the UI from offering
 * a comment it would refuse.
 */
export const hasFollowupTarget = (
  taskInfo: Pick<TaskInfo, 'repoOwner' | 'repoName' | 'number'> | null | undefined,
  prInfo?: { number?: number },
): boolean => Boolean(taskInfo?.repoOwner && taskInfo.repoName && (isThreadNumber(prInfo?.number) || isThreadNumber(taskInfo.number)));

const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;

/**
 * The thread a follow-up submitted for `taskId` will be posted to, or null
 * when it is not known. The API resolves it for the task ID it was read for;
 * task info still held from another task or run names a different thread, so
 * it is never borrowed. The dialog names no thread it cannot vouch for.
 */
export function followupTargetFor(
  taskInfo: Pick<TaskInfo, 'followupTarget'> | null | undefined,
  taskId: string | undefined,
): FollowupTarget | null {
  const target = taskInfo?.followupTarget;
  if (!target || !taskId || target.taskId !== taskId) return null;
  if (target.kind !== 'pull_request' && target.kind !== 'issue') return null;
  if (!isThreadNumber(target.number)) return null;
  if (typeof target.repository !== 'string' || !REPOSITORY.test(target.repository)) return null;
  return target;
}

/** How the dialog names a follow-up's thread, with the repository in full. */
export const describeFollowupTarget = (target: FollowupTarget): string =>
  `${target.kind === 'pull_request' ? 'PR' : 'Issue'} ${target.repository}#${target.number}`;
