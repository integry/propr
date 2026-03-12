import React from 'react';
import { Panel, PanelGroup } from 'react-resizable-panels';

interface RepositoriesPageHeaderProps {
  selectedRepoName?: string;
  onAddRepository: () => void;
}

export const RepositoriesPageHeader: React.FC<RepositoriesPageHeaderProps> = ({
  selectedRepoName,
  onAddRepository,
}) => {
  return (
    <div className="flex-shrink-0 bg-white">
      {/* Unified header row with aligned baseline - same height for perfect horizon alignment */}
      <PanelGroup direction="horizontal">
        {/* Left Header - Repository Library */}
        <Panel defaultSize={40} minSize={25}>
          <div className="h-12 px-4 flex items-center justify-between">
            <h2 className="text-slate-900 text-sm font-semibold leading-none">Repositories</h2>
            <button
              onClick={onAddRepository}
              className="px-3 py-1.5 text-xs font-medium rounded border transition-colors border-slate-300 text-slate-700 hover:bg-slate-50 hover:border-slate-400"
            >
              + Add Repository
            </button>
          </div>
        </Panel>

        {/* Header spacer for resize handle - same width as resize handle */}
        <div className="w-2 bg-slate-100" />

        {/* Right Header - aligned on same baseline */}
        <Panel defaultSize={60} minSize={30}>
          <div className="h-12 px-4 flex items-center">
            <h2 className="text-slate-900 text-sm font-semibold leading-none">
              {selectedRepoName || 'Details'}
            </h2>
          </div>
        </Panel>
      </PanelGroup>
      {/* Continuous horizon line - single unbroken 1px line spanning entire width */}
      <div className="h-px bg-slate-200" />
    </div>
  );
};
