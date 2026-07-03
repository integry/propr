import React from 'react';
import { Book } from 'lucide-react';
import SummaryBrowser from '../SummaryBrowser';

export interface RepoBrowsePanelProps {
  /** Repository owner (e.g., "integry") */
  owner: string;
  /** Repository name (e.g., "propr") */
  repo: string;
}

/**
 * Panel component for browsing repository file summaries.
 * Embeds the SummaryBrowser component within the repository action tabs.
 */
const RepoBrowsePanel: React.FC<RepoBrowsePanelProps> = ({ owner, repo }) => {
  if (!owner || !repo) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4">
        <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center mb-3">
          <Book size={24} className="text-gray-400" />
        </div>
        <h3 className="text-sm font-medium text-gray-700 mb-1">
          Browse Repository
        </h3>
        <p className="text-xs text-gray-500 max-w-xs">
          Select a repository to browse its file summaries.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <SummaryBrowser owner={owner} repo={repo} />
    </div>
  );
};

export default RepoBrowsePanel;
