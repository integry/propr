import React, { useRef, useState } from 'react';
import type { Notification } from '@propr/shared';
import { ExternalLink, Loader2, MessageSquarePlus, OctagonX, X } from 'lucide-react';
import { postTaskFollowup, stopTaskExecution } from '../../api/proprApi';
import { notificationPullRequestUrl } from '../../pages/inboxUtils';
import FollowupModal from '../TaskDetails/FollowupModal';
import { useToast } from '../ui/useToast';

interface NotificationActionsProps {
  notification: Notification;
  mutationsEnabled: boolean;
  onDismiss: () => Promise<void>;
  onChanged: () => Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function visibleActions(
  notification: Notification,
  advertised: ReadonlySet<string>,
  mutationsEnabled: boolean,
  taskId: string | undefined,
  prUrl: string | null,
) {
  return {
    stop: mutationsEnabled && advertised.has('stop') && notification.target.type === 'task',
    followup: mutationsEnabled && advertised.has('follow_up') && taskId !== undefined,
    openPullRequest: prUrl !== null && advertised.has('open_pr'),
    dismiss: mutationsEnabled && advertised.has('dismiss'),
  };
}

// The branching here deliberately mirrors the closed advertised-action union.
export const NotificationActions: React.FC<NotificationActionsProps> = ({
  notification,
  mutationsEnabled,
  onDismiss,
  onChanged,
}) => {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [followupOpen, setFollowupOpen] = useState(false);
  const pendingRef = useRef(false);
  const advertised = new Set(notification.actions);
  const taskId = notification.target.type === 'task'
    ? notification.target.taskId
    : notification.target.type === 'review'
      ? notification.target.taskId
      : undefined;
  const prUrl = notificationPullRequestUrl(notification);

  const begin = () => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setBusy(true);
    return true;
  };

  const finish = () => {
    pendingRef.current = false;
    setBusy(false);
  };

  const stop = async () => {
    if (!taskId || !window.confirm('Stop this task? Current agent work will be interrupted.')) return;
    if (!begin()) return;
    try {
      await stopTaskExecution(taskId);
    } catch (error) {
      addToast({
        type: 'error',
        message: `Couldn't stop the task. ${errorMessage(error, 'Please try again.')}`,
      });
      finish();
      return;
    }
    addToast({ type: 'success', message: 'Stop requested successfully.' });
    try {
      await onChanged();
    } catch (error) {
      addToast({
        type: 'warning',
        message: `Stop was requested, but the Inbox couldn't refresh. ${errorMessage(error, 'Please refresh manually.')}`,
      });
    } finally {
      finish();
    }
  };

  const submitFollowup = async (body: string) => {
    if (!taskId || !begin()) throw new Error('A task action is already in progress.');
    try {
      await postTaskFollowup(taskId, body);
    } catch (error) {
      addToast({
        type: 'error',
        message: `Couldn't post the follow-up. ${errorMessage(error, 'Please try again.')}`,
      });
      finish();
      throw error;
    }
    setFollowupOpen(false);
    addToast({ type: 'success', message: 'Follow-up posted successfully.' });
    try {
      await onChanged();
    } catch (error) {
      addToast({
        type: 'warning',
        message: `Follow-up was posted, but the Inbox couldn't refresh. ${errorMessage(error, 'Please refresh manually.')}`,
      });
    } finally {
      finish();
    }
  };

  const dismiss = async () => {
    if (!begin()) return;
    try {
      await onDismiss();
    } finally {
      finish();
    }
  };

  const openPullRequest = () => {
    if (!prUrl) {
      addToast({ type: 'error', message: "Couldn't open the pull request because its GitHub URL is invalid." });
      return;
    }
    window.open(prUrl, '_blank', 'noopener,noreferrer');
  };

  const [repoOwner, repoName] = notification.target.type === 'system_failure'
    ? []
    : notification.target.repository.split('/');
  const issueNumber = notification.target.type === 'task'
    ? notification.target.issueNumber
    : notification.target.type === 'review'
      ? notification.target.prNumber
      : undefined;
  const actionClass = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-wait disabled:opacity-50';
  const visible = visibleActions(notification, advertised, mutationsEnabled, taskId, prUrl);
  const hasVisibleAction = Object.values(visible).some(Boolean);

  if (!hasVisibleAction) return null;

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label={`Actions for ${notification.title}`}>
        {visible.stop && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void stop()}
            className={`${actionClass} border-red-200 text-red-700 hover:bg-red-50 focus-visible:ring-red-500`}
            aria-label={`Stop ${notification.title}`}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <OctagonX className="h-4 w-4" aria-hidden="true" />}
            Stop
          </button>
        )}
        {visible.followup && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setFollowupOpen(true)}
            className={`${actionClass} border-slate-300 text-slate-700 hover:bg-slate-50 focus-visible:ring-teal-500`}
            aria-label={`Follow up on ${notification.title}`}
          >
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            Follow up
          </button>
        )}
        {visible.openPullRequest && (
          <button
            type="button"
            disabled={busy}
            onClick={openPullRequest}
            className={`${actionClass} border-slate-300 text-slate-700 hover:bg-slate-50 focus-visible:ring-teal-500`}
            aria-label={`Open pull request for ${notification.title}`}
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open PR
          </button>
        )}
        {visible.dismiss && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void dismiss()}
            className={`${actionClass} border-slate-200 text-slate-600 hover:bg-slate-100 focus-visible:ring-slate-400`}
            aria-label={`Dismiss ${notification.title}`}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Dismiss
          </button>
        )}
      </div>
      <FollowupModal
        isOpen={followupOpen}
        onClose={() => { if (!busy) setFollowupOpen(false); }}
        onSubmit={submitFollowup}
        initialContent=""
        taskInfo={{
          repoOwner,
          repoName,
          number: issueNumber,
          type: notification.target.type === 'review' ? 'pr-comment' : undefined,
        }}
      />
    </>
  );
};

export default NotificationActions;
