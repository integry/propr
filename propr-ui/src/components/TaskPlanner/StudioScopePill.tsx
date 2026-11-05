import React from 'react';
import { GitBranch } from 'lucide-react';

/**
 * Phone header scope: the repository and branch in one compact pill, `⎇ propr/main`, so they share
 * the first header tier with the step badge instead of crowding the plan title. The owner is in the tooltip.
 */
export const StudioScopePill: React.FC<{ repository: string; baseBranch: string; className?: string }> = ({ repository, baseBranch, className = '' }) => (
  <span
    data-testid="studio-scope-pill"
    className={`inline-flex min-w-0 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700 ${className}`}
    title={`${repository} / ${baseBranch}`}
  >
    <GitBranch size={12} className="flex-shrink-0 text-slate-500" />
    <span className="truncate">
      {repository.split('/').pop() || repository}
      {baseBranch && <span className="text-slate-500">/{baseBranch}</span>}
    </span>
  </span>
);
