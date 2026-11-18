import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { CreationFooterStats, FooterStats } from './approvedPlanFooterStats';

const Separator = () => <span className="text-gray-400">·</span>;

/** Footer parts in the Plans list's order, then the queue's own buckets; zero counts are left out. */
const ISSUE_STAT_PARTS: Array<{ key: Exclude<keyof FooterStats, 'total'>; label: string; className: string }> = [
  { key: 'processing', label: 'Running', className: 'text-teal-700' },
  { key: 'underReview', label: 'In Review', className: 'text-amber-700' },
  { key: 'queued', label: 'Queued', className: 'text-gray-500' },
  { key: 'blocked', label: 'Blocked', className: 'text-amber-700' },
  { key: 'skipped', label: 'Skipped', className: 'text-gray-500' },
  { key: 'pending', label: 'Pending', className: 'text-gray-500' },
  { key: 'merged', label: 'Merged', className: 'text-slate-500' },
  { key: 'closed', label: 'Closed', className: 'text-gray-500' },
];

const IssueStatsSummary: React.FC<{ stats: FooterStats }> = ({ stats }) => (
  <>
    <span className="font-medium">{stats.total} {stats.total === 1 ? 'Issue' : 'Issues'}</span>
    {ISSUE_STAT_PARTS.filter(part => stats[part.key] > 0).map(part => (
      <React.Fragment key={part.key}>
        <Separator />
        <span className={`whitespace-nowrap ${part.className}`} data-testid={`plan-footer-${part.key}`}>{stats[part.key]} {part.label}</span>
      </React.Fragment>
    ))}
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
