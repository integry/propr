import { useEffect, useRef } from 'react';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import GoalControls from '../components/GoalDetails/GoalControls';
import GoalArtifacts from '../components/GoalDetails/GoalArtifacts';
import GoalPlan from '../components/GoalDetails/GoalPlan';
import GoalStats from '../components/GoalDetails/GoalStats';
import GoalTerminal from '../components/GoalDetails/GoalTerminal';
import { useGoalDetail } from '../components/GoalDetails/useGoalDetail';
import { GoalStateBadge } from './GoalsPageComponents';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { GOALS_RETURN_TO_PARAM, goalsReturnTarget } from './goalsUrlState';
import type { GoalDetail } from '../api/goalsApi';

const artifactUrl = (value: string | null): string | null => {
  if (!value) return null;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
};

const GoalHeader = ({ detail }: { detail: GoalDetail }) => {
  const finalPr = artifactUrl(detail.stats.artifacts.finalPullRequest?.url ?? null);
  const checkpoint = detail.provider.checkpoint?.label
    ?? detail.provider.checkpoint?.checkpointId
    ?? 'not reported';
  return (
    <header className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1"><h1 className="text-lg font-semibold leading-6 text-slate-900 sm:text-xl">{detail.goal.objective}</h1><p className="mt-1 text-xs text-slate-500">{detail.goal.repository}</p></div>
        <GoalStateBadge state={detail.goal.state} />
        {finalPr && <a href={finalPr} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-teal-200 px-2.5 py-1 text-xs font-medium text-teal-700 hover:bg-teal-50">Final PR artifact<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
        <span>Agent: <strong>{detail.goal.agent}</strong></span><span>Effective model: <strong>{detail.goal.effectiveModel}</strong></span>
        {detail.goal.requestedModel !== detail.goal.effectiveModel && <span className="text-blue-700">Pending model: <strong>{detail.goal.requestedModel}</strong></span>}
        <span>Host lifecycle: <strong>{detail.goal.state}</strong> · v{detail.goal.version}</span>
        <span>Provider goal status: <strong>{detail.provider.status ?? 'not reported'}</strong>{detail.provider.statusDetail ? ` · ${detail.provider.statusDetail}` : ''}</span>
        <span>Provider session: <strong>{detail.provider.sessionId ?? 'not started'}</strong> · generation {detail.provider.generation}</span>
        <span>Checkpoint: <strong>{checkpoint}</strong></span>
        <span>Infrastructure recovery: <strong>{detail.infrastructure.recovery.state}</strong>{detail.infrastructure.recovery.attempt > 0 ? ` · attempt ${detail.infrastructure.recovery.attempt}` : ''}</span>
      </div>
      {detail.infrastructure.recovery.reason && <p className="mt-2 text-xs text-amber-700">Infrastructure recovery detail: {detail.infrastructure.recovery.reason}</p>}
    </header>
  );
};

export default function GoalDetailPage() {
  const { goalId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const returnTarget = goalsReturnTarget(searchParams.get(GOALS_RETURN_TO_PARAM));
  const goal = useGoalDetail(goalId);
  const statusRef = useRef<HTMLDivElement>(null);
  useDocumentTitle(goal.detail ? `Goal · ${goal.detail.goal.repository}` : 'Goal');
  useEffect(() => { if (goal.error) statusRef.current?.focus(); }, [goal.error]);

  if (!goalId) return <div role="alert" className="p-6 text-red-700">The goal identifier is missing.</div>;
  if (goal.loading) return <div role="status" aria-label="Loading goal details" className="flex h-full items-center justify-center text-sm text-slate-500">Loading goal details…</div>;
  if (!goal.detail) return (
    <div ref={statusRef} tabIndex={-1} role="alert" className="mx-auto mt-12 max-w-lg rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-800 focus:outline-none">
      <h1 className="font-semibold">Goal unavailable</h1><p className="mt-1">{goal.error ?? 'The goal could not be loaded.'}</p><Link to={returnTarget} className="mt-4 inline-flex items-center text-sm font-medium text-teal-700"><ChevronLeft className="h-4 w-4" aria-hidden="true" />Back to goals</Link>
    </div>
  );

  const { detail } = goal;
  return (
    <div className="h-full overflow-y-auto bg-slate-50 px-3 py-3 sm:px-5 sm:py-4">
      <div className="mx-auto max-w-[1800px]">
        <Link to={returnTarget} className="mb-2 inline-flex items-center rounded text-xs font-medium text-slate-500 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"><ChevronLeft className="h-4 w-4" aria-hidden="true" />Goals</Link>
        <GoalHeader detail={detail} />

        {(goal.actionError || goal.error) && <div role="alert" aria-live="assertive" className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{goal.actionError ?? goal.error}</div>}
        <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.7fr)_minmax(22rem,0.8fr)]">
          <GoalTerminal events={goal.events} connectionState={goal.connectionState} hasMoreBefore={goal.hasMoreBefore} loadingOlder={goal.loadingOlder} onLoadOlder={goal.loadOlder} onViewportAnchorChange={goal.setViewportAnchor} />
          <aside aria-label="Goal operator information" className="space-y-3">
            <GoalControls detail={detail} models={goal.goalModels} readOnly={goal.readOnly} pendingAction={goal.pendingAction} onPause={goal.pause} onResume={goal.resume} onCancel={goal.cancel} onChangeModel={goal.changeModel} onSend={goal.sendMessage} onRetryMessage={goal.retryMessage} onCancelMessage={goal.cancelMessage} />
            <GoalPlan plan={detail.plan} />
            <GoalStats stats={detail.stats} />
            <GoalArtifacts artifacts={detail.stats.artifacts} />
            {detail.infrastructure.warnings.length > 0 && <section aria-labelledby="infrastructure-warnings-title" className="rounded-lg border border-amber-200 bg-amber-50 p-3"><h2 id="infrastructure-warnings-title" className="text-sm font-semibold text-amber-900">Infrastructure and recovery warnings</h2><ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-800">{detail.infrastructure.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul></section>}
          </aside>
        </div>
      </div>
    </div>
  );
}
