import React, { useEffect, useRef, useState, useId } from 'react';
import { HistoryItem } from './types';
import TaskActionSheet from './TaskActionSheet';
import { getDeleteState, type DeletionProps, type OverflowMenuItem } from './taskActions';
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
  /**
   * The one-line bar the mobile header collapses into: Stop stays out while the
   * task works, and everything else moves into the overflow menu.
   */
  compact?: boolean;
  /** Mobile: the overflow opens as a bottom action sheet rather than a popover. */
  sheet?: boolean;
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

/** The task's Stop, and the newest run's when the pane shows an earlier one that is done. */
const StopButtons: React.FC<{
  isActive: boolean;
  stopsLiveRun: boolean;
  stoppingExecution: boolean;
  onStopExecution: () => void;
  liveRun?: LiveRunControl;
}> = ({ isActive, stopsLiveRun, stoppingExecution, onStopExecution, liveRun }) => (
  <>
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
  </>
);

// Delete button component
const DeleteButton: React.FC<DeletionProps> = ({ isActive, stopFailed, deletingTask, onDeleteTask }) => {
  const { isDisabled, title } = getDeleteState(isActive, stopFailed, deletingTask);

  return (
    <button
      role="menuitem"
      onClick={onDeleteTask}
      disabled={isDisabled}
      title={title}
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

const TaskOverflowMenu: React.FC<{
  deletion: DeletionProps;
}> = ({ deletion }) => {
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
          <DeleteButton {...deletion} onDeleteTask={() => {
            setOpen(false);
            triggerRef.current?.focus();
            deletion.onDeleteTask();
          }} />
        </div>
      )}
    </div>
  );
};

/** The collapsed header's actions: Stop while the task works, everything else in the action sheet. */
const CompactActions: React.FC<{
  stopButtons: React.ReactNode;
  deletion?: DeletionProps;
  onFollowUp?: () => void;
  historyItemWithPaths?: HistoryItem;
  onViewPrompt: (promptPath: string) => void;
  onViewLogs: (logsPath: string) => void;
}> = ({ stopButtons, deletion, onFollowUp, historyItemWithPaths, onViewPrompt, onViewLogs }) => {
  const { promptPath, logsPath } = historyItemWithPaths ?? {};
  const items: OverflowMenuItem[] = [];
  if (onFollowUp) items.push({ label: 'Follow Up', title: 'Follow Up - Post a follow-up comment', icon: <MessageSquarePlus size={18} />, onSelect: onFollowUp });
  if (promptPath) items.push({ label: 'Prompt', title: 'View Prompt', icon: <FileText size={18} />, onSelect: () => onViewPrompt(promptPath) });
  if (logsPath) items.push({ label: 'Logs', title: 'View Logs', icon: <Terminal size={18} />, onSelect: () => onViewLogs(logsPath) });
  // Stop is a safety control, so it never folds into the sheet.
  return (
    <div className="flex flex-none items-center gap-1.5">
      {stopButtons}
      {(items.length > 0 || deletion) && <TaskActionSheet items={items} deletion={deletion} />}
    </div>
  );
};

/** The full header's overflow holds only Delete: a popover on desktop, the bottom sheet on mobile. */
const DeleteOverflow: React.FC<{ deletion: DeletionProps; sheet?: boolean }> = ({ deletion, sheet }) => (
  sheet ? <TaskActionSheet items={[]} deletion={deletion} /> : <TaskOverflowMenu deletion={deletion} />
);

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
  compact,
  sheet,
}) => {
  const isActive = ACTIVE_STATUSES.includes(currentStatus);
  // The run on screen is done, but a newer one is still working: its Stop takes this run's place.
  const stopsLiveRun = !isActive && Boolean(liveRun);
  const taskBusy = isActive || stopsLiveRun;
  const isCancelled = currentStatus === 'CANCELLED';
  const deletion = onDeleteTask && { isActive, stopFailed, deletingTask, onDeleteTask };
  const stopButtons = (
    <StopButtons isActive={isActive} stopsLiveRun={stopsLiveRun} stoppingExecution={stoppingExecution} onStopExecution={onStopExecution} liveRun={liveRun} />
  );

  if (compact) {
    return (
      <CompactActions
        stopButtons={stopButtons}
        deletion={deletion}
        onFollowUp={taskBusy ? undefined : onFollowUp}
        historyItemWithPaths={historyItemWithPaths}
        onViewPrompt={onViewPrompt}
        onViewLogs={onViewLogs}
      />
    );
  }

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

      {stopButtons}

      {deletion && <DeleteOverflow deletion={deletion} sheet={sheet} />}
    </div>
  );
};

export default ActionBar;
