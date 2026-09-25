import { formatWorkflowInput, parseWorkflowInput } from './workflowSelectionInput';
import { useDemoMode } from '../contexts/DemoModeContext';
import { Link } from 'react-router-dom';
import React, { useEffect, useState } from 'react';
import { RefreshCw, Square, Trash2 } from 'lucide-react';
import type { MonitoredRepo, RepositoryIndexingStatus } from '../api/proprApi';
import { RepositoryVisualPreviewControl, type RepositoryVisualPreviewSettings } from './RepositoryVisualPreviewControl';
import { IndexingStatusIndicator } from './IndexingStatusIndicator';
import { DeleteRepoDialog } from './DeleteRepoDialog';

const toggleClassName = "relative shrink-0 w-7 h-4 bg-slate-200 rounded-full peer-focus:ring-2 peer-focus:ring-teal-500/20 peer-checked:bg-teal-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:h-3 after:w-3 after:rounded-full after:bg-white after:border after:border-slate-300 after:transition-all peer-checked:after:translate-x-full peer-disabled:opacity-50 peer-disabled:cursor-not-allowed";

const AutoCiFollowupControl: React.FC<{
  repo: MonitoredRepo;
  onToggle: (repoId: string) => void;
  isReadOnly: boolean;
}> = ({ repo, onToggle, isReadOnly }) => {
  if (isReadOnly) return null;

  return (
    <label
      className="flex items-center justify-between gap-4 py-2 text-xs text-slate-600 cursor-pointer"
      title="Automatically create follow-up work when CI fails"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="min-w-0">
        <span className="block">Auto CI follow-up</span>
        <span className="mt-1 block text-slate-500">When a GitHub Actions run fails, ProPR automatically sends a corrective task.</span>
      </span>
      <input
        type="checkbox"
        checked={repo.autoFollowupOnFailedCi === true}
        onChange={() => onToggle(repo.id)}
        className="sr-only peer"
        aria-label={`Automatic CI follow-up for ${repo.name}`}
      />
      <span className={toggleClassName} />
    </label>
  );
};

const CancelCiDuringFollowupControl: React.FC<{
  repo: MonitoredRepo;
  onToggle: (repoId: string) => void;
  onUpdateWorkflows: (repoId: string, workflows: string[]) => void;
  isReadOnly: boolean;
}> = ({ repo, onToggle, onUpdateWorkflows, isReadOnly }) => {
  const selected = repo.cancelCiDuringFollowupWorkflows ?? [];
  // Compared by value, never by array identity: a poll that re-renders this bar
  // must not wipe what the operator is halfway through typing.
  const storedSelection = formatWorkflowInput(selected);
  const [workflows, setWorkflows] = useState(storedSelection);

  useEffect(() => setWorkflows(storedSelection), [repo.id, storedSelection]);

  if (isReadOnly) return null;

  const enabled = repo.cancelCiDuringFollowup === true;
  const commitWorkflows = () => {
    if (workflows === storedSelection) return;
    const next = parseWorkflowInput(workflows);
    if (next === null) return;
    if (next.join('\u0000').toLowerCase() !== selected.join('\u0000').toLowerCase()) onUpdateWorkflows(repo.id, next);
  };

  return (
    <div className="w-full min-w-0 text-xs text-slate-600" onClick={(event) => event.stopPropagation()}>
      <label
        className="flex items-center justify-between gap-4 py-2 cursor-pointer"
        title="Cancel CI while follow-up implementation is in progress"
      >
        <span className="min-w-0">
          <span className="block">Cancel CI while follow-up implementation is in progress</span>
          <span className="mt-1 block text-slate-500">Only the validation workflows you select below are cancelled on the commit ProPR is about to replace. Every other workflow, deployments and previews included, keeps running. If you select nothing here, the instance-wide <code>CANCEL_CI_FOLLOWUP_WORKFLOWS</code> fallback applies instead, and only what it lists is cancelled. Checks start again on the new commit, or resume on the current one if no commit is produced.</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={() => onToggle(repo.id)}
          className="sr-only peer"
          aria-label={`Cancel CI during follow-up implementation for ${repo.name}`}
        />
        <span className={toggleClassName} />
      </label>

      {enabled && (
        <div className="ml-4 mt-1 mb-2 flex min-w-0 flex-col items-stretch gap-1 border-l-2 border-slate-200 pl-4">
          <label className="block w-full min-w-0">
            <span className="mb-1 block">Validation workflows to cancel</span>
            <textarea
              rows={2}
              value={workflows}
              onChange={(event) => setWorkflows(event.target.value)}
              onBlur={commitWorkflows}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } }}
              aria-invalid={parseWorkflowInput(workflows) === null}
              maxLength={4000}
              aria-label={`Validation workflows to cancel for ${repo.name}`}
              className="min-w-0 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-400"
              placeholder="pr-build-check.yml, Full Test Suite"
            />
          </label>
          <p className="text-slate-500">Separate workflows with commas. Quote names containing commas, for example: &quot;Build, Test&quot;.</p>
          {parseWorkflowInput(workflows) === null && <p role="alert">Close quoted workflow names and separate them with commas. Changes have not been saved.</p>}
          {selected.length === 0 ? (
            <p role="status" className="text-amber-700">
              No workflows selected for this repository, so the instance-wide <code>CANCEL_CI_FOLLOWUP_WORKFLOWS</code> fallback decides what is cancelled: whatever it lists is cancelled here, and nothing is cancelled when your operator left it unset. Select the workflows to cancel by file name, path or the name shown on the pull request — for example <code>pr-build-check.yml</code>.
            </p>
          ) : (
            <p role="status" className="text-slate-500">
              Cancels exactly {selected.length === 1 ? 'this workflow' : `these ${selected.length} workflows`}: {formatWorkflowInput(selected)}. A workflow that is not listed is never cancelled, whatever it is called.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

interface RepositorySettingsBarProps {
  repo: MonitoredRepo;
  indexingStatus: RepositoryIndexingStatus | undefined;
  onToggle: (repoId: string) => void;
  onRemove: (repoId: string) => void | Promise<void>;
  onStopIndexing: (repoName: string, baseBranch?: string) => void;
  onReindex: (repoName: string, baseBranch?: string) => void;
  onToggleStar: (repoId: string) => void;
  onToggleHidden: (repoId: string) => void;
  onToggleAutoCiFollowup: (repoId: string) => void;
  onToggleCancelCiDuringFollowup: (repoId: string) => void;
  onUpdateCancelCiWorkflows: (repoId: string, workflows: string[]) => void;
  onToggleNotifications: (repoId: string) => void;
  onUpdateVisualPreview: (repoId: string, settings: RepositoryVisualPreviewSettings) => void;
  isReadOnly: boolean;
}

export const RepositorySettingsBar: React.FC<RepositorySettingsBarProps> = ({
  repo, indexingStatus, onToggle, onRemove, onStopIndexing, onReindex,
  onToggleStar, onToggleHidden, onToggleAutoCiFollowup, onToggleCancelCiDuringFollowup, onUpdateCancelCiWorkflows,
  onToggleNotifications, onUpdateVisualPreview, isReadOnly,
}) => {
  const { isDemoMode } = useDemoMode();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const isIndexing = indexingStatus?.indexing_status === 'indexing';

  const handleDeleteConfirm = async () => {
    if (isReadOnly) return;
    setIsDeleting(true);
    try {
      await onRemove(repo.id);
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  return (
    <section
      aria-label={`Settings for ${repo.name}`}
      className="h-full overflow-y-auto scrollbar-stealth bg-white"
    >
      <div className="w-full max-w-3xl px-4 py-3 sm:px-6">
        {!isDemoMode && <Link to="/tasks/new" state={{ initialRepository: repo.name }} className="mb-5 inline-flex rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white">New task</Link>}
        <div>
          <h3 className="mb-2 text-[10px] uppercase font-bold tracking-widest text-slate-500">Repository</h3>
          <label className="flex items-center justify-between gap-4 py-2 text-xs text-slate-600">
            <span className="min-w-0">
              <span className="block">Monitor repository</span>
              <span className="mt-1 block text-slate-500">Process new issues in this repository.</span>
            </span>
            <input type="checkbox" checked={repo.enabled} onChange={() => onToggle(repo.id)} disabled={isReadOnly} aria-label={`Monitor ${repo.name}`} className="sr-only peer" />
            <span className={toggleClassName} />
          </label>
          <label className="flex items-center justify-between gap-4 py-2 text-xs text-slate-600">
            <span className="min-w-0">Star repository</span>
            <input type="checkbox" checked={repo.starred === true} onChange={() => onToggleStar(repo.id)} disabled={isReadOnly} aria-label="Star repository" className="sr-only peer" />
            <span className={toggleClassName} />
          </label>
          <label className="flex items-center justify-between gap-4 py-2 text-xs text-slate-600">
            <span className="min-w-0">Hide repository</span>
            <input type="checkbox" checked={repo.hidden === true} onChange={() => onToggleHidden(repo.id)} disabled={isReadOnly} aria-label="Hide repository" className="sr-only peer" />
            <span className={toggleClassName} />
          </label>
        </div>

        <div className="mt-8 border-t border-slate-200 pt-6">
          <h3 className="mb-2 text-[10px] uppercase font-bold tracking-widest text-slate-500">Notifications</h3>
          <label className="flex items-center justify-between gap-4 py-2 text-xs text-slate-600">
            <span className="min-w-0">
              <span className="block">Notifications</span>
              <span className="mt-1 block text-slate-500">Generate Inbox and push notifications for this repository. Turning this off silences plan, task, review, pull request, and indexing notifications without changing automation.</span>
            </span>
            <input type="checkbox" checked={repo.notificationsEnabled !== false} onChange={() => onToggleNotifications(repo.id)} disabled={isReadOnly} aria-label={`Notifications for ${repo.name}`} className="sr-only peer" />
            <span className={toggleClassName} />
          </label>
        </div>

        {!isReadOnly && (
          <div className="mt-8 border-t border-slate-200 pt-6">
            <h3 className="mb-2 text-[10px] uppercase font-bold tracking-widest text-slate-500">Automation</h3>
            <div className="flex flex-col">
              <AutoCiFollowupControl repo={repo} onToggle={onToggleAutoCiFollowup} isReadOnly={isReadOnly} />
              <CancelCiDuringFollowupControl
                key={repo.id}
                repo={repo}
                onToggle={onToggleCancelCiDuringFollowup}
                onUpdateWorkflows={onUpdateCancelCiWorkflows}
                isReadOnly={isReadOnly}
              />
              <RepositoryVisualPreviewControl key={repo.id} repo={repo} onUpdate={onUpdateVisualPreview} isReadOnly={isReadOnly} />
            </div>
          </div>
        )}

        <div className="mt-8 border-t border-slate-200 pt-6">
          <h3 className="mb-2 text-[10px] uppercase font-bold tracking-widest text-slate-500">Indexing</h3>
          <dl className="text-xs text-slate-600">
            <div className="flex items-center justify-between gap-4 py-2">
              <dt className="shrink-0">Current Branch</dt>
              <dd className="min-w-0 break-all rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{repo.baseBranch || 'HEAD'}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-2">
              <dt className="shrink-0">Last Indexed</dt>
              <dd className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right">
                {indexingStatus?.last_indexed_hash && (
                  <a
                    href={`https://github.com/${repo.name}/commit/${indexingStatus.last_indexed_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={indexingStatus.last_indexed_commit_message || indexingStatus.last_indexed_hash}
                    className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700 hover:text-teal-700"
                  >
                    {indexingStatus.last_indexed_hash.slice(0, 7)}
                  </a>
                )}
                {indexingStatus?.last_indexed_at ? (
                  <time dateTime={indexingStatus.last_indexed_at} className="text-slate-500">
                    {new Date(indexingStatus.last_indexed_at).toLocaleString()}
                  </time>
                ) : <span className="text-slate-500">Never</span>}
              </dd>
            </div>
            {indexingStatus?.indexing_status !== 'completed' && (
              <div className="flex items-start justify-between gap-4 py-2">
                <dt className="shrink-0">Status</dt>
                <dd className="min-w-0">
                  {indexingStatus ? <IndexingStatusIndicator status={indexingStatus} /> : <span className="text-slate-500">Not indexed</span>}
                </dd>
              </div>
            )}
          </dl>
          <div className="flex items-center justify-between gap-4 py-2 text-xs text-slate-600">
            <span className="min-w-0">Reindex</span>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                aria-label="Reindex repository"
                onClick={() => onReindex(repo.name, repo.baseBranch)}
                disabled={isIndexing || isReadOnly}
                className="inline-flex items-center gap-2 rounded border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isIndexing ? 'animate-spin' : ''}`} />
                Reindex
              </button>
              {isIndexing && (
                <button
                  type="button"
                  onClick={() => onStopIndexing(repo.name, repo.baseBranch)}
                  disabled={isReadOnly}
                  className="inline-flex items-center gap-2 rounded border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop indexing
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-8 border-t border-slate-200 pt-6">
          <button
            type="button"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isReadOnly}
            aria-describedby={`remove-repository-description-${repo.id}`}
            className="inline-flex items-center gap-2 rounded-md border border-red-200 bg-red-50/50 px-4 py-2 text-left text-xs font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            Remove repository from ProPR
          </button>
          <p id={`remove-repository-description-${repo.id}`} className="mt-2 ml-[39px] text-xs text-slate-500">
            This only stops tracking the repository in ProPR. It will not affect the repository on GitHub.
          </p>
        </div>
      </div>
      <DeleteRepoDialog
        isOpen={isDeleteDialogOpen}
        repoName={repo.name}
        onClose={() => setIsDeleteDialogOpen(false)}
        onConfirm={handleDeleteConfirm}
        isLoading={isDeleting}
      />
    </section>
  );
};
