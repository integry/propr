import React from 'react';
import type { MonitoredRepo } from '../api/proprApi';

const toggleClassName = "relative shrink-0 w-7 h-4 bg-slate-200 rounded-full peer-focus:ring-2 peer-focus:ring-teal-500/20 peer-checked:bg-teal-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:border after:border-slate-300 after:transition-all peer-checked:after:translate-x-full peer-disabled:opacity-50 peer-disabled:cursor-not-allowed";

/** Repository-wide switch for the live ProPR status line at the top of ProPR pull request bodies. */
export const RepositoryPrStatusControl: React.FC<{
  repo: MonitoredRepo;
  onToggle: (repoId: string) => void;
  isReadOnly: boolean;
}> = ({ repo, onToggle, isReadOnly }) => (
  <label className="flex items-center justify-between gap-4 py-2 text-xs text-slate-600 cursor-pointer" onClick={(event) => event.stopPropagation()}>
    <span className="min-w-0">
      <span className="block">Show the ProPR status in the pull request</span>
      <span className="mt-1 block text-slate-500">Keep one live line at the top of each open ProPR pull request: working, needs you, or ready to merge, with the review score and checks. Applies to every branch of this repository; turning it off removes the line on the next update.</span>
    </span>
    <input
      type="checkbox"
      checked={repo.prStatusDisplay === true}
      onChange={() => { if (!isReadOnly) onToggle(repo.id); }}
      disabled={isReadOnly}
      className="sr-only peer"
      aria-label={`Show the ProPR status in pull requests for ${repo.name}`}
    />
    <span className={toggleClassName} />
  </label>
);
