import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, GripVertical, X } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import TaskDetails from '../TaskDetails';
import { taskPath } from './rowModel';

interface TaskSplitWorkspaceProps {
  /** The task list; it keeps its place in the tree whether or not a task is open, so it never remounts. */
  list: React.ReactNode;
  /** The task open beside the list, or null for the full-width list. */
  selectedTaskId: string | null;
  onClose: () => void;
  onDeleted: (taskId: string) => void;
}

/** A dialog (the prompt, the log files, a follow-up) handles its own Escape. */
const escapeBelongsElsewhere = (event: KeyboardEvent): boolean =>
  event.defaultPrevented
  || Boolean(document.querySelector('[role="dialog"], [aria-modal="true"]'))
  || (event.target instanceof Element && Boolean(event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')));

/**
 * `/tasks` as a triage console on wide screens: the list on the left and the
 * selected task on the right, with no route change. With nothing selected the
 * list takes the full width, exactly as without the split.
 *
 * Each pane scrolls on its own. The list pane is narrower than the ledger's
 * table breakpoint, so its container query shows the stacked cards there.
 */
const TaskSplitWorkspace: React.FC<TaskSplitWorkspaceProps> = ({ list, selectedTaskId, onClose, onDeleted }) => {
  useEffect(() => {
    if (!selectedTaskId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || escapeBelongsElsewhere(event)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedTaskId, onClose]);

  return (
    <PanelGroup id="task-split-workspace" direction="horizontal" keyboardResizeBy={5} className="h-full bg-white" data-testid="task-split-workspace">
      <Panel id="task-split-list" order={1} defaultSize={selectedTaskId ? 45 : 100} minSize={32}>
        <div className="flex h-full min-h-0 min-w-0 flex-col bg-white" data-testid="task-split-list">
          {list}
        </div>
      </Panel>

      {selectedTaskId && (
        <>
          <PanelResizeHandle
            id="task-split-resize-handle"
            className="group flex w-2 flex-none cursor-col-resize items-center justify-center border-l border-slate-200 bg-slate-50 transition-colors hover:bg-teal-50 focus-visible:outline-none focus-visible:bg-teal-50"
            aria-label="Resize task list and task details"
            hitAreaMargins={{ coarse: 12, fine: 6 }}
          >
            <GripVertical size={12} className="text-slate-400 group-hover:text-teal-700" aria-hidden="true" />
          </PanelResizeHandle>

          <Panel id="task-split-details" order={2} defaultSize={55} minSize={35}>
            <section aria-label="Task details" className="flex h-full min-h-0 min-w-0 flex-col bg-white" data-testid="task-split-details">
              <div className="flex flex-none items-center justify-end gap-1 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
                <Link
                  to={taskPath(selectedTaskId)}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Open full page
                </Link>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close task details"
                  title="Close (Esc)"
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Close
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {/* Keyed by task, so switching tasks drops the old task's live subscriptions and state. */}
                <TaskDetails key={selectedTaskId} taskId={selectedTaskId} embedded onClose={onClose} onDeleted={onDeleted} />
              </div>
            </section>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
};

export default TaskSplitWorkspace;
