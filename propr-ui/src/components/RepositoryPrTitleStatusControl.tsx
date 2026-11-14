import React from 'react';
import type { MonitoredRepo } from '../api/proprApi';

const toggleClassName = "relative shrink-0 w-7 h-4 bg-slate-200 rounded-full peer-focus:ring-2 peer-focus:ring-teal-500/20 peer-checked:bg-teal-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:border after:border-slate-300 after:transition-all peer-checked:after:translate-x-full peer-disabled:opacity-50 peer-disabled:cursor-not-allowed";

/** Repository-wide switch for the PR state emoji in ProPR pull request titles. Controls the title only. */
export const RepositoryPrTitleStatusControl: React.FC<{
  repo: MonitoredRepo;
  onToggle: (repoId: string) => void;
  isReadOnly: boolean;
}> = ({ repo, onToggle, isReadOnly }) => (
  <label className="flex items-center justify-between gap-4 py-2 text-xs text-slate-600 cursor-pointer" onClick={(event) => event.stopPropagation()}>
    <span className="min-w-0">
      <span className="block">Show the PR state as a leading emoji in the pull request title</span>
      <span className="mt-1 block text-slate-500">Controls the title only: the live ProPR status line at the top of the pull request body is always kept up to date. Applies to every branch of this repository.</span>
    </span>
    <input
      type="checkbox"
      checked={repo.prTitleStatus !== false}
      onChange={() => { if (!isReadOnly) onToggle(repo.id); }}
      disabled={isReadOnly}
      className="sr-only peer"
      aria-label={`Show the PR state in pull request titles for ${repo.name}`}
    />
    <span className={toggleClassName} />
  </label>
);
