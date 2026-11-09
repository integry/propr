import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentUser, userHasPermission } from '../../contexts/AuthContext';
import * as api from '../../api/followupHandoffsApi';
import { SettingsSection } from './SettingsLayout';

const button = 'max-w-full rounded border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';

const STATUS_TEXT: Record<string, string> = {
  awaiting_operator: 'Held for an operator',
  released: 'Released',
};
const REASON_TEXT: Record<string, string> = {
  fork_publication_unsupported: 'The pull request comes from a fork; recovery cannot publish to it.',
  usage_limit_retry_unconfirmed: 'A usage-limit retry may already own this request.',
  cancelled_by_user: 'The user cancelled the work before it was published.',
  publication_failed: 'Publishing the retained work failed.',
  head_advanced_externally: 'Newer commits reached the pull request after this attempt.',
  recorded_commit_mismatch: 'The retained commit no longer matches the record.',
  worktree_missing: 'The retained worktree is gone.',
  worktree_not_on_branch: 'The retained worktree left its branch.',
  worktree_restore_failed: 'The retained worktree could not be rebuilt.',
};

/**
 * Operator maintenance. Today: follow-up handoffs held for an operator, which
 * block every later command on their pull request until someone resumes or
 * releases them. Admin-only, like the routes it calls.
 */
export default function MaintenanceSection() {
  const user = useCurrentUser();
  if (user?.role !== 'admin' || !userHasPermission(user, 'instance.manage_runtime')) return null;
  return <HeldFollowups key={user.id} />;
}

function HeldFollowups() {
  const [handoffs, setHandoffs] = useState<api.FollowupHandoffStatus[]>();
  const [busy, setBusy] = useState<string | null>(null);
  const [forceFor, setForceFor] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const run = useCallback(async (label: string, action: () => Promise<string>) => {
    setBusy(label); setError(''); setMessage('');
    try {
      const outcome = await action();
      const next = await api.listFollowupHandoffs();
      if (alive.current) { setHandoffs(next); setMessage(outcome); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Maintenance operation failed.');
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);

  const refresh = useCallback(() => run('refresh', async () => {
    return '';
  }), [run]);
  useEffect(() => { void refresh(); }, [refresh]);

  const key = (handoff: api.FollowupHandoffStatus) => `${handoff.repository}#${handoff.pullRequest}`;
  const when = (updatedAt: number) => new Date(updatedAt).toLocaleString();
  const prUrl = (handoff: api.FollowupHandoffStatus) => `https://github.com/${handoff.repository}/pull/${handoff.pullRequest}`;

  return (
    <SettingsSection
      className="min-w-0 [overflow-wrap:anywhere]"
      title="Maintenance"
      description="Operator decisions that otherwise need the CLI or the admin API."
    >
      <div className="space-y-5 text-xs">
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {message && <p role="status">{message}</p>}
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h5 className="font-semibold text-slate-900">Held follow-ups</h5>
            <button className={button} disabled={busy !== null} onClick={() => void refresh()}>Refresh</button>
          </div>
          <p className="mb-3 max-w-2xl leading-5 text-slate-500">
            A follow-up whose publication is still owed. One held for an operator blocks every later command on its pull request until it is resumed or released.
            Release frees the branch and never deletes files or commits; the next command redoes the request from the current branch.
          </p>
          {handoffs === undefined && !error && <p className="text-slate-500">Loading…</p>}
          {handoffs && handoffs.length === 0 && <p className="py-3 text-slate-500">No follow-up handoffs are tracked.</p>}
          {handoffs && handoffs.length > 0 && (
            <ul className="divide-y divide-slate-100 border-y border-slate-200" aria-label="Held follow-ups">
              {handoffs.map(handoff => {
                const id = key(handoff);
                const held = handoff.status === 'awaiting_operator';
                return (
                  <li key={id} className="py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <a className="font-medium text-slate-900 underline-offset-2 hover:underline" href={prUrl(handoff)} target="_blank" rel="noreferrer">
                        {handoff.repository}#{handoff.pullRequest}
                      </a>
                      <span className="text-slate-500">{STATUS_TEXT[handoff.status] ?? handoff.status} · {handoff.phase.replace(/_/g, ' ')} · updated {when(handoff.updatedAt)}</span>
                    </div>
                    <p className="mt-1 leading-5 text-slate-600">
                      {handoff.statusReason ? (REASON_TEXT[handoff.statusReason] ?? handoff.statusReason.replace(/_/g, ' ')) : 'Recovery is in progress.'}
                      {' '}Branch <code className="rounded bg-slate-100 px-1">{handoff.branchName}</code>.
                      {handoff.commitHash ? <> Unpublished commit <code className="rounded bg-slate-100 px-1">{handoff.commitHash.slice(0, 10)}</code>.</> : ' No commit recorded.'}
                    </p>
                    <p className="mt-1 leading-5 text-slate-500">Next: {handoff.nextAction}.</p>
                    <p className="mt-1 break-all leading-5 text-slate-400">Task {handoff.taskId} · worktree {handoff.retainedWorktreePath}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <button
                        className={button}
                        disabled={busy !== null || !held}
                        onClick={() => void run(id, async () => {
                          const result = await api.resumeFollowupHandoff(handoff.repository, handoff.pullRequest);
                          const summary = result.summary;
                          return `Resumed ${id}: ${summary.published} published, ${summary.settled} settled, ${summary.awaitingOperator} still held.`;
                        })}
                      >Resume</button>
                      <button
                        className={button}
                        disabled={busy !== null}
                        onClick={() => void run(id, async () => {
                          await api.releaseFollowupHandoff(handoff.repository, handoff.pullRequest, { force: forceFor === id });
                          setForceFor(null);
                          return `Released ${id}. Post the command again on the pull request to redo the request.`;
                        })}
                      >{forceFor === id ? 'Release anyway' : 'Release'}</button>
                      <label className="flex items-center gap-2 text-slate-600">
                        <input type="checkbox" checked={forceFor === id} onChange={event => setForceFor(event.target.checked ? id : null)} />
                        <span>Release even if the worktree holds unpublished work</span>
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
