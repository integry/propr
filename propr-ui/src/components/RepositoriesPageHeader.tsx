import React from 'react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import { EyeOff } from 'lucide-react';

interface RepositoriesPageHeaderProps {
  selectedRepoName?: string;
  onAddRepository: () => void;
  showHiddenRepos: boolean;
  onToggleShowHidden: () => void;
  hiddenCount: number;
}

export const RepositoriesPageHeader: React.FC<RepositoriesPageHeaderProps> = ({
  selectedRepoName,
  onAddRepository,
  showHiddenRepos,
  onToggleShowHidden,
  hiddenCount,
}) => {
  return (
    <div className="flex-shrink-0 bg-white">
      {/* Mobile header - simple single row */}
      <div className="lg:hidden h-12 px-4 flex items-center justify-between border-b border-slate-200">
        <h2 className="text-slate-900 text-sm font-semibold leading-none">Repositories</h2>
        <div className="flex items-center gap-2">
          {hiddenCount > 0 && (
            <label className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-500 hover:text-slate-700">
              <input
                type="checkbox"
                checked={showHiddenRepos}
                onChange={onToggleShowHidden}
                className="w-3.5 h-3.5 rounded border-slate-300 text-teal-500 focus:ring-teal-500/20"
              />
              <EyeOff className="w-3 h-3" />
              <span>Show hidden ({hiddenCount})</span>
            </label>
          )}
          <button
            onClick={onAddRepository}
            className="px-3 py-1.5 text-xs font-medium rounded border transition-colors border-slate-300 text-slate-700 hover:bg-slate-50 hover:border-slate-400"
          >
            + Add Repository
          </button>
        </div>
      </div>

      {/* Desktop header - split panel layout */}
      <div className="hidden lg:block">
        {/* Unified header row with aligned baseline - same height for perfect horizon alignment */}
        <PanelGroup direction="horizontal">
          {/* Left Header - Repository Library */}
          <Panel defaultSize={40} minSize={25}>
            <div className="h-12 px-4 flex items-center justify-between">
              <h2 className="text-slate-900 text-sm font-semibold leading-none">Repositories</h2>
              <div className="flex items-center gap-3">
                {hiddenCount > 0 && (
                  <label className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                    <input
                      type="checkbox"
                      checked={showHiddenRepos}
                      onChange={onToggleShowHidden}
                      className="w-3.5 h-3.5 rounded border-slate-300 text-teal-500 focus:ring-teal-500/20"
                    />
                    <EyeOff className="w-3 h-3" />
                    <span>Show hidden ({hiddenCount})</span>
                  </label>
                )}
                <button
                  onClick={onAddRepository}
                  className="px-3 py-1.5 text-xs font-medium rounded border transition-colors border-slate-300 text-slate-700 hover:bg-slate-50 hover:border-slate-400"
                >
                  + Add Repository
                </button>
              </div>
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
    </div>
  );
};
