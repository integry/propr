import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { CreationFooterStats, FooterStats } from './approvedPlanFooterStats';

const Separator = () => <span className="text-gray-400">·</span>;

const IssueStatsSummary: React.FC<{ stats: FooterStats }> = ({ stats }) => (
  <>
    <span className="font-medium">{stats.total} {stats.total === 1 ? 'Issue' : 'Issues'}</span>
    {stats.merged > 0 && <><Separator /><span className="text-slate-500">{stats.merged} Merged</span></>}
    {stats.processing > 0 && <><Separator /><span className="text-teal-700">{stats.processing} Running</span></>}
    {stats.pending > 0 && <><Separator /><span className="text-gray-500">{stats.pending} Pending</span></>}
  </>
);

const CreationStatsSummary: React.FC<{ stats: CreationFooterStats }> = ({ stats }) => {
  const parts = [
    stats.creating > 0 ? `${stats.creating} Creating` : null,
    stats.queued > 0 ? `${stats.queued} Queued` : null,
    stats.failed > 0 ? `${stats.failed} Failed` : null,
  ].filter(Boolean);
  return (
    <>
      <span className="font-medium" data-testid="plan-footer-creation">
        {stats.created} of {stats.total} {stats.total === 1 ? 'Issue' : 'Issues'} Created
      </span>
      {parts.length > 0 && <span className="text-gray-500">({parts.join(' · ')})</span>}
    </>
  );
};

export const PlanFooterStats: React.FC<{ stats: FooterStats; creation?: CreationFooterStats | null; onRefresh: () => void }> = ({ stats, creation, onRefresh }) => (
  <div className="mobile-safe-action-area flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-t border-gray-200 bg-gray-100 flex-shrink-0">
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs sm:text-sm text-gray-600" data-testid="plan-footer-stats">
      {creation ? <CreationStatsSummary stats={creation} /> : <IssueStatsSummary stats={stats} />}
    </div>
    <button
      onClick={onRefresh}
      className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors flex-shrink-0"
      title="Refresh issues"
    >
      <RefreshCw size={16} />
    </button>
  </div>
);
