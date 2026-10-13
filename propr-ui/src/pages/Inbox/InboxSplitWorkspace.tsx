import React, { useEffect } from 'react';
import { GripVertical } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { isDialogOpen, isTypingTarget } from '../../components/TaskList/keyboardOwnership';
import { VERDICT_PANE_ATTRIBUTE } from './useInboxTriage';

interface InboxSplitWorkspaceProps {
  /** The queue; it keeps its place in the tree whether or not a verdict is open, so it never remounts. */
  list: React.ReactNode;
  /** The Triage Verdict Card, or null for the full-width queue. */
  verdict: React.ReactNode | null;
  onClose: () => void;
}

/** A dialog or a field handles its own Escape. */
const escapeBelongsElsewhere = (event: KeyboardEvent): boolean =>
  event.defaultPrevented || isDialogOpen() || isTypingTarget(event.target);

/**
 * `/inbox` as a triage console on wide screens: the queue on the left and a
 * lightweight verdict for the selected notification on the right. With nothing
 * selected the queue takes the full width, exactly as without the split.
 * Each pane scrolls on its own.
 */
const InboxSplitWorkspace: React.FC<InboxSplitWorkspaceProps> = ({ list, verdict, onClose }) => {
  const open = verdict !== null;

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || escapeBelongsElsewhere(event)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  return (
    <PanelGroup id="inbox-split-workspace" direction="horizontal" keyboardResizeBy={5} className="min-h-0 flex-1 bg-white" data-testid="inbox-split-workspace">
      <Panel id="inbox-split-list" order={1} defaultSize={open ? 35 : 100} minSize={28}>
        <div className="h-full min-h-0 min-w-0 overflow-y-auto bg-white" data-testid="inbox-split-list">
          {list}
        </div>
      </Panel>

      {open && (
        <>
          <PanelResizeHandle
            id="inbox-split-resize-handle"
            className="group flex w-2 flex-none cursor-col-resize items-center justify-center border-l border-slate-200 bg-slate-50 transition-colors hover:bg-teal-50 focus-visible:outline-none focus-visible:bg-teal-50"
            aria-label="Resize Inbox queue and triage verdict"
            hitAreaMargins={{ coarse: 12, fine: 6 }}
          >
            <GripVertical size={12} className="text-slate-400 group-hover:text-teal-700" aria-hidden="true" />
          </PanelResizeHandle>

          <Panel id="inbox-split-verdict" order={2} defaultSize={65} minSize={35}>
            <section
              aria-label="Triage verdict"
              className="flex h-full min-h-0 min-w-0 flex-col bg-white"
              data-testid="inbox-split-verdict"
              {...{ [VERDICT_PANE_ATTRIBUTE]: '' }}
            >
              {verdict}
            </section>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
};

export default InboxSplitWorkspace;
