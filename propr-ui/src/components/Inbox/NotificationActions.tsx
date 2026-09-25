import React, { useRef, useState } from 'react';
import type { Notification } from '@propr/shared';
import { Loader2, Terminal } from 'lucide-react';
import { postTaskFollowup } from '../../api/proprApi';
import { notificationFollowupCommand } from '../../pages/inboxUtils';
import { useToast } from '../ui/useToast';

interface NotificationActionsProps {
  notification: Notification;
  mutationsEnabled: boolean;
  onCommandSent: () => Promise<void>;
  className?: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const NotificationActions: React.FC<NotificationActionsProps> = ({
  notification,
  mutationsEnabled,
  onCommandSent,
  className = '',
}) => {
  const { addToast } = useToast();
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const followup = notificationFollowupCommand(notification);

  if (!mutationsEnabled || !followup) return null;

  const send = async (command: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPendingCommand(command);
    try {
      await postTaskFollowup(followup.taskId, command, 'pull_request');
    } catch (error) {
      addToast({
        type: 'error',
        message: `Couldn't send ${command} to PR #${followup.prNumber}. ${errorMessage(error, 'Please try again.')}`,
      });
      pendingRef.current = false;
      setPendingCommand(null);
      return;
    }
    addToast({ type: 'success', message: `Sent ${command} to PR #${followup.prNumber}.` });
    // The command is the follow-up this card asked for, so the card is done.
    await onCommandSent();
  };

  return (
    <div className={`flex min-w-0 items-center gap-2 ${className}`} aria-label={`Actions for ${notification.title}`}>
      {followup.commands.map(command => (
        <button
          key={command}
          type="button"
          disabled={pendingCommand !== null}
          onClick={() => void send(command)}
          className="inline-flex min-h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 font-mono text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1 disabled:cursor-wait disabled:opacity-50 sm:min-h-7 sm:gap-1 sm:px-2"
          aria-label={`Send ${command} to PR #${followup.prNumber}`}
        >
          {pendingCommand === command
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            : <Terminal className="h-3.5 w-3.5" aria-hidden="true" />}
          {command}
        </button>
      ))}
    </div>
  );
};

export default NotificationActions;
