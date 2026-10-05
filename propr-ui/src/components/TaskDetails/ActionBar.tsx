import React, { useEffect, useRef, useState, useId } from 'react';
import { HistoryItem } from './types';
import { FileText, Terminal, Square, Loader2, Ban, Trash2, MessageSquarePlus, MoreHorizontal } from 'lucide-react';

interface ActionBarProps {
  currentStatus: string;
  historyItemWithPaths?: HistoryItem;
  stoppingExecution: boolean;
  stopFailed?: boolean;
  deletingTask?: boolean;
  onStopExecution: () => void;
  onViewPrompt: (promptPath: string) => void;
  onViewLogs: (logsPath: string) => void;
  onDeleteTask?: () => void;
  onFollowUp?: () => void;
  /**
   * The task's newest run when the pane shows an earlier one. While it works,
   * its Stop stays in the header, so the agent can be stopped from any run.
   */
  liveRun?: LiveRunControl;
}

export interface LiveRunControl {
  number: number;
  stopping: boolean;
  onStop: () => void;
}

const ACTIVE_STATUSES = ['PENDING', 'QUEUED', 'PROCESSING', 'CLAUDE_EXECUTION', 'CLAUDE_EXECUTION_STARTED', 'CLAUDE_EXECUTION_COMPLETED', 'POST_PROCESSING'];

// Cancelled badge component
const CancelledBadge: React.FC<{ isCancelled: boolean }> = ({ isCancelled }) => {
  if (!isCancelled) return null;
  return (
    <span
      className="flex items-center gap-1.5 bg-orange-50 text-orange-700 px-2 py-1 rounded text-[11px] font-medium border border-orange-200"
      title="Task was cancelled by user"
    >
      <Ban size={14} />
      Cancelled
    </span>
  );
};

// Stop execution button component
const StopExecutionButton: React.FC<{
  isActive: boolean;
  stoppingExecution: boolean;
  onStopExecution: () => void;
  title?: string;
}> = ({ isActive, stoppingExecution, onStopExecution, title = 'Stop Execution' }) => {
  if (!isActive) return null;
  return (
    <button
      onClick={onStopExecution}
      disabled={stoppingExecution}
      title={stoppingExecution ? 'Stopping execution...' : title}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
        stoppingExecution
          ? 'bg-red-50 text-red-400 cursor-not-allowed border border-red-200'
          : 'bg-red-100 hover:bg-red-200 text-red-600 hover:text-red-700 border border-red-200'
      }`}
    >
      {stoppingExecution ? (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>Stopping...</span>
        </>
      ) : (
        <>
          <Square size={14} />
          <span>Stop</span>
        </>
      )}
    </button>
  );
};

// Delete button component
const DeleteButton: React.FC<{
  isActive: boolean;
  stopFailed: boolean;
  deletingTask: boolean;
  onDeleteTask: () => void;
}> = ({ isActive, stopFailed, deletingTask, onDeleteTask }) => {
  // Enable delete if task is not active, or if stop failed
  const canDelete = !isActive || stopFailed;
  const isDisabled = !canDelete || deletingTask;

  const getTitle = () => {
    if (deletingTask) return 'Deleting...';
    if (stopFailed) return 'Delete task (stop failed, task may have already stopped)';
    if (isActive) return 'Stop the task before deleting';
    return 'Delete task';
  };

  return (
    <button
      role="menuitem"
      onClick={onDeleteTask}
      disabled={isDisabled}
      title={getTitle()}
      className={`flex items-center gap-1.5 w-full px-3 py-2 rounded text-xs font-medium transition-colors ${
        isDisabled
          ? 'bg-gray-50 text-gray-400 cursor-not-allowed border border-gray-200'
          : 'bg-white hover:bg-red-50 text-red-500 hover:text-red-600 border border-gray-200 hover:border-red-200'
      }`}
    >
      {deletingTask ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Trash2 size={14} />
      )}
      <span>Delete</span>
    </button>
  );
};

const TaskOverflowMenu: React.FC<React.ComponentProps<typeof DeleteButton>> = props => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    (menu?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu)?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="relative ml-1 border-l border-slate-200 pl-2"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label="More task actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="flex h-7 w-7 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div id={menuId} ref={menuRef} role="menu" aria-label="More task actions" tabIndex={-1}
          className="absolute right-0 top-full z-50 mt-1 w-44 rounded border border-slate-200 bg-white p-1 shadow-lg">
          <DeleteButton {...props} onDeleteTask={() => {
            setOpen(false);
            triggerRef.current?.focus();
            props.onDeleteTask();
          }} />
        </div>
      )}
    </div>
  );
};

// Ghost button style for action buttons - small with icon + text
const ghostButtonClass = "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-white/80 border border-transparent hover:border-slate-200 transition-colors";

const ActionBar: React.FC<ActionBarProps> = ({
  currentStatus,
  historyItemWithPaths,
  stoppingExecution,
  stopFailed = false,
  deletingTask = false,
  onStopExecution,
  onViewPrompt,
  onViewLogs,
  onDeleteTask,
  onFollowUp,
  liveRun,
}) => {
  const isActive = ACTIVE_STATUSES.includes(currentStatus);
  // The run on screen is done, but a newer one is still working: its Stop takes this run's place.
  const stopsLiveRun = !isActive && Boolean(liveRun);
  const taskBusy = isActive || stopsLiveRun;
  const isCancelled = currentStatus === 'CANCELLED';

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto sm:flex-shrink-0">
      <CancelledBadge isCancelled={isCancelled} />

      {/* View Prompt Button - Ghost style */}
      {historyItemWithPaths?.promptPath && (
        <button
          onClick={() => onViewPrompt(historyItemWithPaths.promptPath!)}
          title="View Prompt"
          className={ghostButtonClass}
        >
          <FileText size={13} />
          <span>Prompt</span>
        </button>
      )}

      {/* View Logs Button - Ghost style */}
      {historyItemWithPaths?.logsPath && (
        <button
          onClick={() => onViewLogs(historyItemWithPaths.logsPath!)}
          title="View Logs"
          className={ghostButtonClass}
        >
          <Terminal size={13} />
          <span>Logs</span>
        </button>
      )}

      {/* Follow Up Button - Ghost style */}
      {onFollowUp && !taskBusy && (
        <button
          onClick={onFollowUp}
          title="Follow Up - Post a follow-up comment"
          className={ghostButtonClass}
        >
          <MessageSquarePlus size={13} />
          <span>Follow Up</span>
        </button>
      )}

      {/* Divider before destructive actions, only when it divides them from something */}
      {taskBusy && (historyItemWithPaths?.promptPath || historyItemWithPaths?.logsPath) && (
        <div aria-hidden="true" className="h-4 w-px bg-slate-200 mx-1" />
      )}

      <StopExecutionButton
        isActive={isActive}
        stoppingExecution={stoppingExecution}
        onStopExecution={onStopExecution}
      />
      {liveRun && (
        <StopExecutionButton
          isActive={stopsLiveRun}
          stoppingExecution={liveRun.stopping}
          onStopExecution={liveRun.onStop}
          title={`Stop Run ${liveRun.number}, which is still running`}
        />
      )}

      {onDeleteTask && (
        <TaskOverflowMenu
          isActive={isActive}
          stopFailed={stopFailed}
          deletingTask={deletingTask}
          onDeleteTask={onDeleteTask}
        />
      )}
    </div>
  );
};

export default ActionBar;
