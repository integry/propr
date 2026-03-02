import React from 'react';
import { HistoryItem } from './types';
import { FileText, Terminal, Square, Loader2, Ban, Trash2, MessageSquarePlus } from 'lucide-react';

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
}

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
}> = ({ isActive, stoppingExecution, onStopExecution }) => {
  if (!isActive) return null;
  return (
    <button
      onClick={onStopExecution}
      disabled={stoppingExecution}
      title={stoppingExecution ? 'Stopping execution...' : 'Stop Execution'}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
        stoppingExecution
          ? 'bg-red-50 text-red-400 cursor-not-allowed border border-red-200'
          : 'bg-red-100 hover:bg-red-200 text-red-600 hover:text-red-700 border border-red-200'
      }`}
    >
      {stoppingExecution ? (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span className="hidden sm:inline">Stopping...</span>
        </>
      ) : (
        <>
          <Square size={14} />
          <span className="hidden sm:inline">Stop</span>
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
      onClick={onDeleteTask}
      disabled={isDisabled}
      title={getTitle()}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
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
      <span className="hidden sm:inline">Delete</span>
    </button>
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
  onFollowUp
}) => {
  const isActive = ['PENDING', 'QUEUED', 'PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(currentStatus);
  const isCancelled = currentStatus === 'CANCELLED';

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <CancelledBadge isCancelled={isCancelled} />

      {/* View Prompt Button - Ghost style */}
      {historyItemWithPaths?.promptPath && (
        <button
          onClick={() => onViewPrompt(historyItemWithPaths.promptPath!)}
          title="View Prompt"
          className={ghostButtonClass}
        >
          <FileText size={13} />
          <span className="hidden sm:inline">Prompt</span>
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
          <span className="hidden sm:inline">Logs</span>
        </button>
      )}

      {/* Follow Up Button - Ghost style */}
      {onFollowUp && !isActive && (
        <button
          onClick={onFollowUp}
          title="Follow Up - Post a follow-up comment"
          className={ghostButtonClass}
        >
          <MessageSquarePlus size={13} />
          <span className="hidden sm:inline">Follow Up</span>
        </button>
      )}

      {/* Divider before destructive actions */}
      {(isActive || onDeleteTask) && (
        <div className="h-4 w-px bg-slate-300 mx-1" />
      )}

      <StopExecutionButton
        isActive={isActive}
        stoppingExecution={stoppingExecution}
        onStopExecution={onStopExecution}
      />

      {onDeleteTask && (
        <DeleteButton
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
