import React from 'react';
import { GripVertical } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import './AiAgentsPage.css';

interface AiAgentsDesktopWorkspaceProps {
  addKind: 'agent' | 'pool';
  addDisabled: boolean;
  configuration: React.ReactNode;
  playground: React.ReactNode;
  onAdd: () => void;
}

const AiAgentsDesktopWorkspace: React.FC<AiAgentsDesktopWorkspaceProps> = ({
  addKind,
  addDisabled,
  configuration,
  playground,
  onAdd,
}) => {
  const addLabel = addKind === 'pool' ? 'Pool' : 'Agent';

  return (
    <div className="ai-agents-workspace hidden h-full overflow-hidden bg-white sm:block">
      <PanelGroup
        id="ai-agents-workspace"
        direction="horizontal"
        keyboardResizeBy={5}
        className="h-full"
        data-testid="ai-agents-panel-group"
      >
        <Panel id="ai-agents-configuration" order={1} defaultSize={40} minSize={25}>
          <section
            className="ai-agents-pane flex h-full min-w-0 flex-col bg-white"
            data-testid="ai-agents-configuration-pane"
            aria-labelledby="ai-agents-configuration-heading"
          >
            <div className="ai-agents-pane-header flex flex-none items-center justify-between gap-2 border-b border-slate-200 bg-white">
              <h2 id="ai-agents-configuration-heading" aria-label="Agent Configuration" className="min-w-0 font-semibold leading-tight text-gray-900">
                <span className="ai-agents-heading-wide">Agent Configuration</span>
                <span className="ai-agents-heading-compact">Configuration</span>
              </h2>
              <button
                type="button"
                onClick={onAdd}
                disabled={addDisabled}
                aria-label={`+ Add ${addLabel}`}
                title={`Add ${addLabel}`}
                className={`ai-agents-add-button inline-flex flex-none items-center justify-center whitespace-nowrap rounded-md border text-sm font-medium transition-colors ${
                  addDisabled
                    ? 'cursor-not-allowed border-gray-200 text-gray-400'
                    : 'border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                }`}
              >
                <span aria-hidden="true">+</span>
                <span className="ai-agents-add-wide">Add {addLabel}</span>
                <span className="ai-agents-add-compact">{addLabel}</span>
              </button>
            </div>
            <div className="ai-agents-pane-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="ai-agents-configuration-scroll">
              <div className="ai-agents-configuration-content">{configuration}</div>
            </div>
          </section>
        </Panel>

        <PanelResizeHandle
          id="ai-agents-resize-handle"
          className="ai-agents-resize-handle group relative flex w-2 flex-none cursor-col-resize items-center justify-center bg-white focus-visible:outline-none"
          aria-label="Resize agent configuration and playground"
          hitAreaMargins={{ coarse: 12, fine: 6 }}
          data-testid="ai-agents-resize-handle"
        >
          <span className="ai-agents-resize-line" aria-hidden="true" />
          <GripVertical size={12} className="ai-agents-resize-grip text-slate-400" aria-hidden="true" />
        </PanelResizeHandle>

        <Panel id="ai-agents-playground" order={2} defaultSize={60} minSize={30}>
          <section
            className="ai-agents-pane flex h-full min-w-0 flex-col bg-slate-50"
            data-testid="ai-agents-playground-pane"
            aria-labelledby="ai-agents-playground-heading"
          >
            <div className="ai-agents-pane-header flex flex-none items-center border-b border-slate-200 bg-white">
              <h2 id="ai-agents-playground-heading" className="font-semibold leading-tight text-gray-900">Playground</h2>
            </div>
            <div className="min-h-0 flex-1" data-testid="ai-agents-playground-content">{playground}</div>
          </section>
        </Panel>
      </PanelGroup>
    </div>
  );
};

export default AiAgentsDesktopWorkspace;
