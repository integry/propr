import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, GripVertical, Maximize2, X } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import TaskDetails from '../TaskDetails';
import type { RunRevealHistory } from '../TaskDetails/RunTimeline';
import { buildTaskRow, buildTaskRuns, taskPath } from './rowModel';
import type { TaskGroup } from './types';
import { isDialogOpen, isTypingTarget } from './keyboardOwnership';

interface TaskSplitWorkspaceProps {
  /** The task list; it keeps its place in the tree whether or not a task is open, so it never remounts. */
  list: React.ReactNode;
  /** The task open beside the list, or null for the full-width list. */
  selectedTaskId: string | null;
  /** The list row the open run belongs to; with more than one run, the pane's timeline lists them all. */
  selectedGroup?: TaskGroup | null;
  /** Opens another run of the same task in the pane. */
  onSelectRun?: (taskId: string) => void;
  /**
   * Whether the viewport fits the list and the task side by side. Narrower,
   * the open task covers the list as a single pane instead. Either way the
   * task stays mounted where it is, so a resize keeps its open diff, an
   * unsent follow-up and its scroll, and the list keeps its page and place.
   */
  split?: boolean;
  onClose: () => void;
  onDeleted: (taskId: string) => void;
}

/** Window controls: compact icon buttons docked in the pane's header, not a row of their own. */
// Ghost icon buttons with a fixed 28px hit box, matching the weight of the task's own actions.
const PANE_ACTION_CLASSES = 'inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

/** A dialog or a field handles its own Escape. */
const escapeBelongsElsewhere = (event: KeyboardEvent): boolean =>
  event.defaultPrevented || isDialogOpen() || isTypingTarget(event.target);

/**
 * `/tasks` as a triage console on wide screens: the list on the left and the
 * selected task on the right, with no route change. With nothing selected the
 * list takes the full width, exactly as without the split. Narrower, the
 * selected task covers the list as a single pane with a way back to it.
 *
 * Each pane scrolls on its own. The list pane is narrower than the ledger's
 * table breakpoint, so its container query shows the stacked cards there.
 */
const TaskSplitWorkspace: React.FC<TaskSplitWorkspaceProps> = ({ list, selectedTaskId, selectedGroup, onSelectRun, split = true, onClose, onDeleted }) => {
  // This owner survives the selected run's keyed details remount.
  const revealHistory: RunRevealHistory = useRef(null);
  useEffect(() => {
    if (!selectedTaskId) revealHistory.current = null;
  }, [selectedTaskId]);
  const runs = useMemo(() => (selectedGroup ? buildTaskRuns(buildTaskRow(selectedGroup)) : undefined), [selectedGroup]);

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

  // The task covers the list on narrow screens, and the list goes inert under
  // it: focus left in the list moves to the task rather than to the page.
  const listCovered = Boolean(selectedTaskId) && !split;
  const listRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (listCovered && listRef.current?.contains(document.activeElement)) detailsRef.current?.focus({ preventScroll: true });
  }, [listCovered]);

  return (
    <PanelGroup id="task-split-workspace" direction="horizontal" keyboardResizeBy={5} className="relative h-full bg-white" data-testid="task-split-workspace" data-layout={split ? 'split' : 'single'}>
      <Panel id="task-split-list" order={1} defaultSize={selectedTaskId ? 45 : 100} minSize={32}>
        {/* Hidden, not removed, under the task: the list keeps its page, filters and scroll for the way back. */}
        <div ref={listRef} inert={listCovered} className={`flex h-full min-h-0 min-w-0 flex-col bg-white${listCovered ? ' invisible' : ''}`} data-testid="task-split-list">
          {list}
        </div>
      </Panel>

      {selectedTaskId && (
        <>
          <PanelResizeHandle
            id="task-split-resize-handle"
            className={`group ${split ? 'flex' : 'hidden'} w-2 flex-none cursor-col-resize items-center justify-center border-l border-slate-200 bg-slate-50 transition-colors hover:bg-teal-50 focus-visible:outline-none focus-visible:bg-teal-50`}
            aria-label="Resize task list and task details"
            hitAreaMargins={{ coarse: 12, fine: 6 }}
          >
            <GripVertical size={12} className="text-slate-400 group-hover:text-teal-700" aria-hidden="true" />
          </PanelResizeHandle>

          {/* Narrow, the same panel lies over the list, so nothing in it remounts as the window crosses the breakpoint.
              No z-index: a stacking context here would trap the task's dialogs under the app's toolbar. */}
          <Panel id="task-split-details" order={2} defaultSize={55} minSize={35} className={split ? undefined : 'absolute inset-0'}>
            <section ref={detailsRef} tabIndex={-1} aria-label="Task details" className="flex h-full min-h-0 min-w-0 flex-col bg-white focus:outline-none" data-testid="task-split-details">
              {/* Phones hide the header that carries the pane's controls, so the way back gets its own row. */}
              {!split && (
                <div className="flex flex-none items-center border-b border-slate-200 px-2 py-1 sm:hidden">
                  <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded px-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Back to tasks
                  </button>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-hidden">
                {/* Keyed by task, so switching tasks drops the old task's live subscriptions and state, and only that does. */}
                <TaskDetails
                  key={selectedTaskId}
                  taskId={selectedTaskId}
                  embedded
                  onClose={onClose}
                  onDeleted={onDeleted}
                  runs={runs}
                  revealHistory={revealHistory}
                  onSelectRun={onSelectRun}
                  paneControls={(
                    <>
                      <Link
                        to={taskPath(selectedTaskId)}
                        aria-label="Open full page"
                        title="Open full page"
                        className={PANE_ACTION_CLASSES}
                      >
                        <Maximize2 className="h-4 w-4" aria-hidden="true" />
                      </Link>
                      <button
                        type="button"
                        onClick={onClose}
                        aria-label={split ? 'Close task details' : 'Back to tasks'}
                        title={split ? 'Close (Esc)' : 'Back to tasks (Esc)'}
                        className={PANE_ACTION_CLASSES}
                      >
                        {split ? <X className="h-4 w-4" aria-hidden="true" /> : <ArrowLeft className="h-4 w-4" aria-hidden="true" />}
                      </button>
                    </>
                  )}
                />
              </div>
            </section>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
};

export default TaskSplitWorkspace;
