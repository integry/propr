import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ExternalLink, SquareArrowOutUpRight } from 'lucide-react';
import { isNotificationPreviewEligible, type Notification, type PublishedVisualPreview } from '@propr/shared';
import { getFileChanges } from '../../api/fileChangesApi';
import { getTaskHistory } from '../../api/proprApi';
import NotificationActions from '../../components/Inbox/NotificationActions';
import { ReferenceChip } from '../../components/TaskList/ReferenceChips';
import { readTaskGroup, readTaskRuns, taskGroupRuns } from '../../components/TaskDetails/readTaskRuns';
import MarkdownRenderer from '../../components/TaskDetails/MarkdownRenderer';
import TaskVisualPreviews from '../../components/TaskDetails/TaskVisualPreviews';
import { taskPath, type TaskRunEntry } from '../../components/TaskList/rowModel';
import { useOptionalSocket } from '../../contexts/useSocket';
import {
  formatRelativeTime,
  notificationKindLabel,
  notificationPullRequestUrl,
  notificationReference,
  notificationRepository,
  notificationStatus,
} from '../inboxUtils';
import { reviewedRunId, reviewFindings, taskHistorySummary, triageTaskId, trimDiffForTriage, type TriageDiff } from './triageVerdict';

interface TriageVerdictCardProps {
  notification: Notification;
  mutationsEnabled: boolean;
  onDismiss: (id: string) => void;
  onCommandSent: (id: string) => Promise<void>;
  /** Window controls docked in the card's header, such as Close. */
  paneControls?: React.ReactNode;
}

const SECTION_HEADING = 'text-[11px] font-bold uppercase tracking-wider text-slate-500';

const pluralize = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

interface TriageReadState {
  diff: TriageDiff | null;
  /** The run's full summary and visual previews from its history; null until read, or when it cannot be. */
  details: TriageDetails | null;
  /** The task's runs, oldest first; null until read, or when they cannot be. */
  runs: TaskRunEntry[] | null;
}

interface TriageRead extends TriageReadState {
  /** Reads the task's runs again and shows them; null when the task is not found. */
  readRuns: () => Promise<TaskRunEntry[] | null>;
}

interface TriageDetails {
  /** Null when the run recorded no full summary, so the notification's own body stands in. */
  summary: string | null;
  previews: PublishedVisualPreview[] | undefined;
}

/** The full summary and visual previews a run's history records. */
const readDetails = async (taskId: string): Promise<TriageDetails | null> => {
  const data = await getTaskHistory(taskId).catch(() => null) as {
    history?: unknown;
    previewMedia?: PublishedVisualPreview[];
    taskInfo?: { previewMedia?: PublishedVisualPreview[] };
  } | null;
  if (!data) return null;
  return { summary: taskHistorySummary(data.history), previews: data.previewMedia ?? data.taskInfo?.previewMedia };
};

/** A diff that cannot be read reads as no changes, so a review still falls back to the code it read. */
const readDiff = async (taskId: string): Promise<TriageDiff> =>
  trimDiffForTriage((await getFileChanges(taskId).catch(() => null))?.files ?? []);

/**
 * What the card reads for the selected notification: the run's full summary
 * and visual previews, the few changed lines behind it and its task's runs, each read once per selection and silent when
 * they fail, because the verdict is what the card is for. A review commits
 * nothing, so when its own run shows no changes the card shows the newest
 * earlier run of the task that pushed a commit, the code it read. The runs are
 * read again whenever a task in the repository starts or settles, so a newer
 * run started elsewhere withdraws the commands it supersedes.
 */
function useTriageRead(taskId: string | null, isReview: boolean, repository: string | null): TriageRead {
  const [read, setRead] = useState<TriageReadState>({ diff: null, details: null, runs: null });
  // Every runs read takes a number; only the newest one started is shown, and none once the selection changes.
  const runsReadRef = useRef(0);
  const readRuns = useCallback(async () => {
    if (!taskId) return null;
    const sequence = ++runsReadRef.current;
    const runs = await readTaskRuns(taskId);
    if (sequence === runsReadRef.current) setRead(previous => ({ ...previous, runs }));
    return runs;
  }, [taskId]);

  useEffect(() => {
    setRead({ diff: null, details: null, runs: null });
    if (!taskId) return;
    let current = true;
    void readDetails(taskId).then(details => { if (current) setRead(previous => ({ ...previous, details })); });
    const sequence = ++runsReadRef.current;
    const group = readTaskGroup(taskId).catch(() => null);
    void group.then(found => {
      if (current && found && sequence === runsReadRef.current) setRead(previous => ({ ...previous, runs: taskGroupRuns(found) }));
    });
    const readTriageDiff = async () => {
      const own = await readDiff(taskId);
      if (own.files.length > 0 || !isReview || !current) return own;
      const found = await group;
      const reviewed = found && current ? reviewedRunId(found.tasks, taskId) : null;
      return reviewed && current ? readDiff(reviewed) : own;
    };
    void readTriageDiff().then(diff => { if (current) setRead(previous => ({ ...previous, diff })); });
    return () => {
      current = false;
      runsReadRef.current += 1;
    };
  }, [taskId, isReview]);

  const socket = useOptionalSocket();
  const { onActivityUpdate, subscribeToActivity, unsubscribeFromActivity } = socket ?? {};
  useEffect(() => {
    if (!taskId || !onActivityUpdate) return;
    const stop = onActivityUpdate(payload => {
      if (payload.domain !== 'task' || payload.change === 'progress') return;
      if (repository && payload.repository && payload.repository !== repository) return;
      void readRuns().catch(() => undefined);
    });
    subscribeToActivity?.();
    return () => {
      stop();
      unsubscribeFromActivity?.();
    };
  }, [taskId, repository, readRuns, onActivityUpdate, subscribeToActivity, unsubscribeFromActivity]);

  return { ...read, readRuns };
}

const ReviewVerdict: React.FC<{ notification: Notification }> = ({ notification }) => {
  const { score, issueCount, findings } = reviewFindings(notification);
  const unlistedFindings = issueCount - findings.length;
  if (findings.length === 0) {
    return <p className="whitespace-pre-line break-words text-sm leading-6 text-slate-700">{notification.body}</p>;
  }
  return (
    <section aria-labelledby="triage-verdict-heading">
      <h3 id="triage-verdict-heading" className={SECTION_HEADING}>
        Review verdict: {pluralize(issueCount, 'finding')}{score === null ? '' : ` (Score ${score}/10)`}
      </h3>
      <ol className="mt-3 space-y-3">
        {findings.map(finding => (
          <li key={finding.index} className="flex gap-3 text-sm leading-5">
            <span className="flex-none font-mono text-xs leading-5 text-slate-400">{finding.index}.</span>
            <div className="min-w-0">
              {finding.reference && (
                <code className="block break-all font-mono text-xs leading-5 text-slate-900">{finding.reference}</code>
              )}
              {finding.text && <p className="break-words text-slate-700">{finding.text}</p>}
            </div>
          </li>
        ))}
      </ol>
      {unlistedFindings > 0 && (
        <p className="mt-3 text-xs text-slate-500">{pluralize(unlistedFindings, 'more finding')} in Tasks</p>
      )}
    </section>
  );
};

/**
 * The run's summary in full, as its agent or reviewer wrote it. Runs that
 * recorded none, and the moment before it is read, show the notification's
 * verdict instead.
 */
const TriageSummary: React.FC<{ notification: Notification; summary: string | null }> = ({ notification, summary }) => {
  if (!summary) return <ReviewVerdict notification={notification} />;
  return (
    <section aria-labelledby="triage-summary-heading">
      <h3 id="triage-summary-heading" className={SECTION_HEADING}>
        {notification.target.type === 'review' ? 'Review summary' : 'Summary'}
      </h3>
      <div className="prose prose-sm mt-2 max-w-none break-words text-sm leading-6 text-slate-700 prose-li:marker:text-teal-600" data-testid="triage-summary">
        <MarkdownRenderer text={summary} />
      </div>
    </section>
  );
};

const VisualDiff: React.FC<{ diff: TriageDiff }> = ({ diff }) => {
  if (diff.files.length === 0) return null;
  return (
    <section aria-labelledby="triage-diff-heading">
      <h3 id="triage-diff-heading" className={SECTION_HEADING}>
        Visual diff ({pluralize(diff.files.length + diff.hiddenFiles, 'file')})
      </h3>
      {diff.files.map(file => (
        <figure key={file.path} className="mt-3 overflow-hidden rounded-md border border-slate-200">
          <figcaption className="truncate border-b border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-xs text-slate-600" title={file.path}>
            {file.path}
          </figcaption>
          <pre className="overflow-x-auto py-1 font-mono text-xs leading-5" data-testid="triage-diff-lines">
            {file.lines.map((line, index) => (
              <div
                key={index}
                className={`whitespace-pre px-3 ${line.kind === 'added' ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-900'}`}
              >
                {line.kind === 'added' ? '+ ' : '- '}{line.text}
              </div>
            ))}
          </pre>
          {file.hiddenLines > 0 && (
            <p className="border-t border-slate-200 px-3 py-1 text-xs text-slate-500">
              {pluralize(file.hiddenLines, 'more changed line')}
            </p>
          )}
        </figure>
      ))}
      {diff.hiddenFiles > 0 && (
        <p className="mt-2 text-xs text-slate-500">{pluralize(diff.hiddenFiles, 'more file')} in Tasks</p>
      )}
    </section>
  );
};

/**
 * The Inbox's right pane: why the AI stopped and whether it is safe to tell it
 * to continue. It shows the run's full summary, its visual previews, a bounded
 * diff and the decision buttons;
 * the full workbench stays in /tasks, one `Inspect in Tasks` away.
 */
const TriageVerdictCard: React.FC<TriageVerdictCardProps> = ({
  notification,
  mutationsEnabled,
  onDismiss,
  onCommandSent,
  paneControls,
}) => {
  const taskId = triageTaskId(notification);
  const repository = notification.target.type === 'system_failure' ? null : notification.target.repository;
  const { diff, details, runs, readRuns } = useTriageRead(taskId, notification.target.type === 'review', repository);
  const reference = notificationReference(notification);
  const pullRequestUrl = notificationPullRequestUrl(notification);
  const status = notificationStatus(notification);
  const canDismiss = mutationsEnabled && notification.actions.includes('dismiss');

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="triage-verdict-card">
      <header className="flex-none border-b border-slate-200 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2 text-xs leading-5 text-slate-500">
          <span className="min-w-0 truncate font-medium text-slate-700" title={notificationRepository(notification)}>
            {notificationRepository(notification)}
          </span>
          {reference && (pullRequestUrl ? (
            <a href={pullRequestUrl} target="_blank" rel="noopener noreferrer" aria-label={`${reference.label} on GitHub`}
              className="inline-flex flex-none items-center gap-1 rounded-sm hover:underline focus-visible:outline-teal-500">
              <ReferenceChip title={reference.title}>{reference.label}</ReferenceChip>
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : <span className="flex-none"><ReferenceChip title={reference.title}>{reference.label}</ReferenceChip></span>)}
          <span className="flex-none text-slate-300" aria-hidden="true">·</span>
          <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="triage-status">
            <span className={`h-2 w-2 flex-none rounded-full ${status.className}`} aria-hidden="true" />
            <span className="truncate">{notificationKindLabel(notification)} · {status.label}</span>
          </span>
          <time className="flex-none" dateTime={notification.occurredAt} title={new Date(notification.occurredAt).toLocaleString()}>
            {formatRelativeTime(notification.occurredAt)}
          </time>
          {/* Done removes the item for good, so it neither looks like nor sits beside Close, which only hides the pane. */}
          <div className="ml-auto flex flex-none items-center gap-3">
            {canDismiss && (
              <button
                type="button"
                onClick={() => onDismiss(notification.id)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 px-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                title="Dismiss from the Inbox (x)"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Done
              </button>
            )}
            {paneControls && (
              <div className="flex items-center border-l border-slate-200 pl-3">{paneControls}</div>
            )}
          </div>
        </div>
        <h2 className="mt-1 break-words text-base font-semibold leading-6 text-slate-950">{notification.title}</h2>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        <TriageSummary notification={notification} summary={details?.summary ?? null} />
        {/* The notification carries one preview; the run's history has them all. */}
        <TaskVisualPreviews
          previews={details?.previews ?? (isNotificationPreviewEligible(notification) ? notification.previewMedia : undefined)}
          className=""
        />
        {diff && <VisualDiff diff={diff} />}
      </div>

      <footer className="flex flex-none flex-wrap items-center gap-3 border-t border-slate-200 px-5 py-3">
        {taskId && (
          <Link
            to={taskPath(taskId)}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            Inspect in Tasks
            <SquareArrowOutUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
        <NotificationActions
          notification={notification}
          runs={runs}
          readRuns={readRuns}
          mutationsEnabled={mutationsEnabled}
          onCommandSent={() => onCommandSent(notification.id)}
          className="ml-auto"
        />
      </footer>
    </div>
  );
};

export default TriageVerdictCard;
