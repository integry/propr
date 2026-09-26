import React, { useEffect, useRef, useState } from 'react';
import type { Notification } from '@propr/shared';
import { Loader2, MoreHorizontal, Terminal } from 'lucide-react';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const followup = notificationFollowupCommand(notification);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

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

  const [primary, ...secondary] = followup.commands;
  const commandIcon = (command: string) => (pendingCommand === command
    ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
    : <Terminal className="h-3.5 w-3.5" aria-hidden="true" />);
  const buttonClass = 'items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white font-mono text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1 disabled:cursor-wait disabled:opacity-50 sm:min-h-7 sm:gap-1 sm:px-2';

  // Phones show the primary command and tuck the rest behind a menu, so every row keeps one command line.
  return (
    <div className={`flex min-w-0 items-center gap-2 ${className}`} aria-label={`Actions for ${notification.title}`}>
      {[primary, ...secondary].map(command => (
        <button
          key={command}
          type="button"
          disabled={pendingCommand !== null}
          onClick={() => void send(command)}
          className={`${command === primary ? 'inline-flex' : 'hidden sm:inline-flex'} min-h-10 px-3 ${buttonClass}`}
          aria-label={`Send ${command} to PR #${followup.prNumber}`}
        >
          {commandIcon(command)}
          {command}
        </button>
      ))}
      {secondary.length > 0 && (
        <div ref={menuRef} className="relative sm:hidden">
          <button
            type="button"
            disabled={pendingCommand !== null}
            onClick={() => setMenuOpen(open => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More commands for PR #${followup.prNumber}`}
            className={`inline-flex h-10 w-10 ${buttonClass}`}
          >
            {pendingCommand && secondary.includes(pendingCommand)
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <MoreHorizontal className="h-4 w-4" aria-hidden="true" />}
          </button>
          {menuOpen && (
            <div role="menu" className="absolute bottom-full right-0 z-20 mb-1 min-w-[10rem] overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
              {secondary.map(command => (
                <button
                  key={command}
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); void send(command); }}
                  className="flex min-h-10 w-full items-center gap-2 px-3 text-left font-mono text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                  aria-label={`Send ${command} to PR #${followup.prNumber}`}
                >
                  <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                  {command}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationActions;
