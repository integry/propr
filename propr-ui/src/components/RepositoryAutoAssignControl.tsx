import React, { useEffect, useState } from 'react';
import type { MonitoredRepo } from '../api/proprApi';
import { parseAutoAssignDefaultAssignee } from '../hooks/repositoryVisualPreview';

const toggleClassName = "relative shrink-0 w-7 h-4 bg-slate-200 rounded-full peer-focus:ring-2 peer-focus:ring-teal-500/20 peer-checked:bg-teal-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:border after:border-slate-300 after:transition-all peer-checked:after:translate-x-full peer-disabled:opacity-50 peer-disabled:cursor-not-allowed";

export interface RepositoryAutoAssignHandlers {
  onToggle: (repoId: string) => void;
  onUpdateTarget: (repoId: string, login: string | null) => void;
  onToggleReview: (repoId: string) => void;
}

export const RepositoryAutoAssignControl: React.FC<RepositoryAutoAssignHandlers & {
  repo: MonitoredRepo;
  isReadOnly: boolean;
}> = ({ repo, onToggle, onUpdateTarget, onToggleReview, isReadOnly }) => {
  const stored = repo.autoAssignDefaultAssignee ?? null;
  // Compared by value so a poll that re-renders the bar keeps unsaved typing.
  const [login, setLogin] = useState(stored ?? '');
  useEffect(() => setLogin(stored ?? ''), [repo.id, stored]);

  const enabled = repo.autoAssignPullRequests === true;
  const parsed = parseAutoAssignDefaultAssignee(login);
  const invalid = parsed === undefined;

  const commitLogin = () => {
    if (isReadOnly || invalid || parsed === stored) return;
    onUpdateTarget(repo.id, parsed);
  };

  return (
    <div className="w-full min-w-0 text-xs text-slate-600" onClick={(event) => event.stopPropagation()}>
      <label className="flex items-center justify-between gap-4 py-2 cursor-pointer">
        <span className="min-w-0">
          <span className="block">Assign the pull request when ProPR finishes</span>
          <span className="mt-1 block text-slate-500">When ProPR opens or updates a pull request, assign it to someone so it lands in their review queue. Applies to every branch of this repository.</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={() => { if (!isReadOnly) onToggle(repo.id); }}
          disabled={isReadOnly}
          className="sr-only peer"
          aria-label={`Assign pull requests for ${repo.name}`}
        />
        <span className={toggleClassName} />
      </label>

      {enabled && (
        <div className="ml-4 mt-1 mb-2 flex min-w-0 flex-col items-stretch gap-1 border-l-2 border-slate-200 pl-4">
          <label className="block w-full min-w-0">
            <span className="mb-1 block">Assignee</span>
            <input
              type="text"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              onBlur={commitLogin}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
              disabled={isReadOnly}
              aria-invalid={invalid}
              maxLength={100}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label={`Default assignee for ${repo.name}`}
              className="min-w-0 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400 disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder="Issue author"
            />
          </label>
          {invalid ? (
            <p role="alert" className="text-red-600">Enter a GitHub login, such as octocat, or leave it empty to assign the issue author. Changes have not been saved.</p>
          ) : (
            <p role="status" className="text-slate-500">
              {stored ? <>Pull requests are assigned to <code>@{stored}</code>.</> : 'Empty, so the author of the issue is assigned. Bot authors are skipped.'}
            </p>
          )}
          <label className="flex items-center justify-between gap-4 py-2 cursor-pointer">
            <span className="min-w-0">
              <span className="block">Also request a review from the assignee</span>
              <span className="mt-1 block text-slate-500">Skipped when the assignee authored the pull request, since GitHub does not allow it.</span>
            </span>
            <input
              type="checkbox"
              checked={repo.autoAssignRequestReview === true}
              onChange={() => { if (!isReadOnly) onToggleReview(repo.id); }}
              disabled={isReadOnly}
              className="sr-only peer"
              aria-label={`Request a review from the assignee for ${repo.name}`}
            />
            <span className={toggleClassName} />
          </label>
        </div>
      )}
    </div>
  );
};
