import React from 'react';
import { RotateCcw } from 'lucide-react';
import type { TaskAttempt, TaskInfo } from './types';

const taskHref = (taskId: string) => `/tasks/${encodeURIComponent(taskId)}`;

const causeText = (cause: TaskAttempt['replacementCause']) => cause === 'infra_lost'
  ? 'replaced a run lost with its worker'
  : cause === 'provider_transient' ? 'replaced a run ended by a transient provider error' : 'original run';

/** Whether the task belongs to an automatic-replacement lineage. */
function hasAttemptLineage(taskInfo: TaskInfo | null | undefined): boolean {
  return Boolean(taskInfo && ((taskInfo.attemptNumber ?? 1) > 1 || taskInfo.replacesTaskId || taskInfo.replacedByTaskId));
}

/**
 * Attempt lineage of an automatically replaced task: which attempt this is, and
 * links to the attempts before and after it.
 */
const AttemptLineage: React.FC<{ taskInfo: TaskInfo | null | undefined }> = ({ taskInfo }) => {
  if (!taskInfo || !hasAttemptLineage(taskInfo)) return null;
  const attempt = taskInfo.attemptNumber ?? 1;
  const lineage = taskInfo.attemptLineage ?? [];
  const total = lineage.length > 0 ? Math.max(attempt, ...lineage.map(entry => entry.attemptNumber)) : undefined;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800"
      role="group"
      aria-label="Attempt lineage"
      data-testid="attempt-lineage"
    >
      <RotateCcw size={11} aria-hidden="true" />
      <span className="font-medium">Attempt {attempt}{total ? ` of ${total}` : ''}</span>
      {lineage.length > 1 ? lineage.map(entry => entry.attemptNumber === attempt ? (
        <span key={entry.taskId} className="font-mono" aria-current="page" title={`Attempt ${entry.attemptNumber}: ${causeText(entry.replacementCause)} (${entry.state ?? 'unknown'})`}>
          #{entry.attemptNumber}
        </span>
      ) : (
        <a
          key={entry.taskId}
          href={taskHref(entry.taskId)}
          className="font-mono underline decoration-dotted hover:text-blue-700"
          title={`Attempt ${entry.attemptNumber}: ${causeText(entry.replacementCause)} (${entry.state ?? 'unknown'})`}
        >
          #{entry.attemptNumber}
        </a>
      )) : (
        <>
          {taskInfo.replacesTaskId && (
            <a href={taskHref(taskInfo.replacesTaskId)} className="underline decoration-dotted hover:text-blue-700" title={taskInfo.replacesTaskId}>
              replaces previous
            </a>
          )}
          {taskInfo.replacedByTaskId && (
            <a href={taskHref(taskInfo.replacedByTaskId)} className="underline decoration-dotted hover:text-blue-700" title={taskInfo.replacedByTaskId}>
              replaced by next
            </a>
          )}
        </>
      )}
    </span>
  );
};

export default AttemptLineage;
