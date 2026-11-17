import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCurrentUser } from '../../contexts/AuthContext';
import { canManageHeldFollowups } from './settingsPermissions';
import * as api from '../../api/followupHandoffsApi';
import { SettingsSection } from './SettingsLayout';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { AgentConfirmDialog } from '../../components/Agents/AgentConfirmDialog';
import { useSettingsSectionVisible } from './settingsSectionVisibility';
import {
  isHeldFollowup, isOpenFollowup, needsCancelledChoice, nextStep, phaseLabel, reasonLabel, statusLabel, updatedLabel,
} from './heldFollowupText';

const button = 'max-w-full rounded border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';
const chip = 'rounded bg-slate-100 px-1 font-mono text-[11px]';
/** Held follow-ups change on their own (recovery, auto-release), so the open list re-reads quietly. */
const REFRESH_MS = 60_000;

type Handoff = api.FollowupHandoffStatus;
const keyOf = (handoff: Handoff) => `${handoff.repository}#${handoff.pullRequest}`;
/**
 * One attempt on a pull request. A later follow-up on the same pull request is a
 * different attempt, so a choice made for one must not carry over to the next.
 */
const attemptOf = (handoff: Handoff) => `${keyOf(handoff)}:${handoff.taskId}`;
const isOpenAttempt = (handoffs: Handoff[], attempt: string) =>
  handoffs.some(handoff => isOpenFollowup(handoff) && attemptOf(handoff) === attempt);
const staleRelease = (id: string) => `${id} changed while you were deciding. Nothing was released; check it and choose again.`;
const prUrl = (handoff: Handoff) => `https://github.com/${handoff.repository}/pull/${handoff.pullRequest}`;

/**
 * Held follow-ups: follow-ups that stopped before their work reached the pull
 * request. One held for a decision blocks new commands on its pull request
 * until someone resumes or releases it. Admin-only, like the routes it calls.
 */
export default function MaintenanceSection() {
  const user = useCurrentUser();
  if (!canManageHeldFollowups(user)) return null;
  return <HeldFollowups key={user.id} />;
}

function HeldFollowups() {
  const visible = useSettingsSectionVisible();
  const [handoffs, setHandoffs] = useState<Handoff[]>();
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Consent to release unpublished work, bound to the attempt it was ticked for.
  const [forceFor, setForceFor] = useState<string | null>(null);
  // Consent to publish cancelled work, bound to the attempt it was ticked for.
  const [publishCancelledFor, setPublishCancelledFor] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState<{ handoff: Handoff; force: boolean } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const alive = useRef(true);
  const loaded = useRef(false);
  // The rows of the latest successful read; Release is checked against them before it is sent.
  const latest = useRef<Handoff[]>([]);
  // Generation of the newest list read. Reads resolve in any order, so only the newest
  // may write rows, `latest`, consent or the load error; an action bumps it so a read
  // that started before the action cannot bring back what the action changed.
  const generation = useRef(0);
  const dropPendingReads = useCallback(() => { generation.current++; }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // A failed background read keeps the rows on screen; only a failed first read shows an error.
  const load = useCallback(async () => {
    const request = ++generation.current;
    const isNewest = () => alive.current && request === generation.current;
    try {
      const next = await api.listFollowupHandoffs();
      if (!isNewest()) return;
      loaded.current = true;
      latest.current = next;
      setHandoffs(next); setLoadError('');
      // Drop consent once its attempt is gone or no longer waits for that choice.
      setPublishCancelledFor(current => (
        current !== null && next.some(handoff => needsCancelledChoice(handoff) && attemptOf(handoff) === current) ? current : null
      ));
      setForceFor(current => (current !== null && isOpenAttempt(next, current) ? current : null));
    } catch (e) {
      if (isNewest() && !loaded.current) setLoadError(e instanceof Error ? e.message : 'Held follow-ups are unavailable.');
    }
  }, []);

  // Read only while the Maintenance category (or a search hit) shows this section.
  useEffect(() => {
    if (!visible) return;
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, REFRESH_MS);
    return () => { clearInterval(timer); dropPendingReads(); };
  }, [visible, load, dropPendingReads]);

  const run = useCallback(async (id: string, action: () => Promise<string>) => {
    setBusy(id); setError(''); setMessage('');
    dropPendingReads();
    try {
      const outcome = await action();
      if (alive.current) setMessage(outcome);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Something went wrong. The follow-up is unchanged.');
    } finally {
      await load();
      if (alive.current) setBusy(null);
    }
  }, [load, dropPendingReads]);

  const resume = (handoff: Handoff) => {
    const id = keyOf(handoff);
    const authorizeCancelled = needsCancelledChoice(handoff) && publishCancelledFor === attemptOf(handoff);
    void run(id, async () => {
      const { summary } = authorizeCancelled
        ? await api.resumeFollowupHandoff(handoff.repository, handoff.pullRequest, { authorizeCancelled: true })
        : await api.resumeFollowupHandoff(handoff.repository, handoff.pullRequest);
      setPublishCancelledFor(null);
      if (summary.awaitingOperator > 0) return `Resumed ${id}, but it is still held.`;
      if (summary.published > 0) return `Resumed ${id}. Its work is published.`;
      return `Resumed ${id}.`;
    });
  };

  const release = (handoff: Handoff, force: boolean) => {
    const id = keyOf(handoff);
    setConfirmRelease(null);
    // The server releases whatever attempt is current on the pull request, so only
    // send the decision while the attempt it was made for is still the open one.
    if (!isOpenAttempt(latest.current, attemptOf(handoff))) {
      setError(staleRelease(id));
      return;
    }
    void run(id, async () => {
      await api.releaseFollowupHandoff(handoff.repository, handoff.pullRequest, { force });
      setForceFor(null);
      return `Released ${id}. Post the command on the pull request again to redo it.`;
    });
  };

  const open = handoffs?.filter(isOpenFollowup) ?? [];
  const released = handoffs?.filter(handoff => !isOpenFollowup(handoff)) ?? [];
  // An open Release confirmation belongs to one attempt; a read that no longer lists it open withdraws it.
  const confirmable = confirmRelease !== null && handoffs !== undefined && isOpenAttempt(handoffs, attemptOf(confirmRelease.handoff));
  useEffect(() => {
    if (confirmRelease === null || confirmable) return;
    setConfirmRelease(null);
    setMessage(''); setError(staleRelease(keyOf(confirmRelease.handoff)));
  }, [confirmRelease, confirmable]);

  return (
    <SettingsSection
      className="min-w-0 [overflow-wrap:anywhere]"
      title="Held follow-ups"
      description="Follow-ups that stopped before their work reached the pull request."
    >
      <div className="space-y-4 text-xs">
        <p className="max-w-2xl leading-5 text-slate-500">
          A held follow-up blocks new commands on its pull request. Resume tries to publish it again; Release drops it and unblocks the pull request. Nothing is deleted.
        </p>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {message && <p role="status">{message}</p>}
        {handoffs === undefined && (loadError
          ? <p role="alert" className="text-red-700">{loadError}</p>
          : <ListSkeleton label="Loading held follow-ups…" rows={2} />)}
        {handoffs && open.length === 0 && <p className="py-3 text-slate-500">No held follow-ups.</p>}
        {open.length > 0 && (
          <ul className="divide-y divide-slate-100 border-y border-slate-200" aria-label="Held follow-ups">
            {open.map(handoff => {
              const id = keyOf(handoff);
              const held = isHeldFollowup(handoff);
              const force = forceFor === attemptOf(handoff);
              const next = nextStep(handoff);
              return (
                <li key={id} className="py-3">
                  <FollowupSummary handoff={handoff} />
                  {next && <p className="mt-1 leading-5 text-slate-500">{next}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                    {held && (
                      <div className="flex flex-wrap items-center gap-3">
                        <button className={button} disabled={busy !== null} onClick={() => resume(handoff)}>Resume</button>
                        {needsCancelledChoice(handoff) && (
                          <label className="flex items-center gap-2 text-slate-600">
                            <input type="checkbox" checked={publishCancelledFor === attemptOf(handoff)} onChange={event => setPublishCancelledFor(event.target.checked ? attemptOf(handoff) : null)} />
                            <span>Publish the cancelled work</span>
                          </label>
                        )}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <button className={button} disabled={busy !== null} onClick={() => setConfirmRelease({ handoff, force })}>Release</button>
                      <label className="flex items-center gap-2 text-slate-600">
                        <input type="checkbox" checked={force} onChange={event => setForceFor(event.target.checked ? attemptOf(handoff) : null)} />
                        <span>Also release if it has unpublished work</span>
                      </label>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {released.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer select-none py-1 font-medium text-slate-600 hover:text-slate-900">Show released ({released.length})</summary>
            <ul className="mt-2 divide-y divide-slate-100 border-y border-slate-200" aria-label="Released follow-ups">
              {released.map(handoff => <li key={keyOf(handoff)} className="py-3"><FollowupSummary handoff={handoff} /></li>)}
            </ul>
          </details>
        )}
      </div>
      {confirmRelease && confirmable && (
        <AgentConfirmDialog
          title={`Release ${keyOf(confirmRelease.handoff)}?`}
          confirmLabel="Release"
          tone="danger"
          onCancel={() => setConfirmRelease(null)}
          onConfirm={() => release(confirmRelease.handoff, confirmRelease.force)}
        >
          <p>
            It stops blocking new commands on its pull request. Nothing is deleted; post the command again to redo it.
            {confirmRelease.force && ' Any unpublished commits stay on the branch.'}
          </p>
        </AgentConfirmDialog>
      )}
    </SettingsSection>
  );
}

/** One follow-up: pull request, state, reason, branch and task. Shared by open and released rows. */
function FollowupSummary({ handoff }: { handoff: Handoff }) {
  const released = !isOpenFollowup(handoff);
  const updated = updatedLabel(handoff.updatedAt);
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <a className="font-medium text-slate-900 underline-offset-2 hover:underline" href={prUrl(handoff)} target="_blank" rel="noreferrer">
          {keyOf(handoff)}
        </a>
        <span className="text-slate-500">
          {released ? '' : `${statusLabel(handoff.status)} · ${phaseLabel(handoff.phase)} · `}<time dateTime={updated.iso} title={updated.absolute}>{updated.relative}</time>
        </span>
      </div>
      <p className="mt-1 leading-5 text-slate-600">
        {reasonLabel(handoff)}
        {' '}Branch <code className={chip}>{handoff.branchName}</code>.
        {!released && handoff.commitHash && <> Unpublished commit <code className={chip}>{handoff.commitHash.slice(0, 10)}</code>.</>}
      </p>
      <p className="mt-1 leading-5 text-slate-500">
        Task{' '}
        <Link className="break-all text-teal-700 underline-offset-2 hover:underline" to={`/tasks/${encodeURIComponent(handoff.taskId)}`}>{handoff.taskId}</Link>
      </p>
    </>
  );
}
