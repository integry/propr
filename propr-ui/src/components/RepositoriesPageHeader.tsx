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
    <div className="flex-shrink-0 border-b border-slate-200 bg-white">
      <PanelGroup direction="horizontal">
        {/* Left Header */}
        <Panel defaultSize={40} minSize={25}>
          <div className="h-14 px-6 flex items-center justify-between">
            <h2 className="text-gray-900 text-lg font-semibold">Repositories</h2>
            <button
              onClick={onAddRepository}
              className="px-3 py-1.5 text-sm font-medium rounded-md border transition-colors border-gray-300 text-gray-700 hover:bg-gray-50 hover:border-gray-400"
            >
              + Add Repository
            </button>
          </div>
        </Panel>

        {/* Header spacer for resize handle */}
        <div className="w-2" />

        {/* Right Header */}
        <Panel defaultSize={60} minSize={30}>
          <div className="h-14 px-6 flex items-center">
            <h2 className="text-gray-900 text-lg font-semibold">
              {selectedRepoName || 'Details'}
            </h2>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
};
