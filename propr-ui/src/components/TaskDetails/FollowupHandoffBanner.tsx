import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import { taskPath } from '../TaskList/rowModel';
import type { FollowupHandoff, FollowupHandoffRun } from './useFollowupHandoff';

interface FollowupHandoffBannerProps {
  /** Nothing is shown without one. */
  handoff: FollowupHandoff | null;
  onSelectRun?: (taskId: string) => void;
  onDismiss: () => void;
}

const runOutcome = (runs: FollowupHandoffRun[]) => {
  const statuses = runs.map(run => run.status);
  if (statuses.some(status => !['completed', 'failed', 'cancelled'].includes(status))) return 'working';
  if (statuses.every(status => status === 'completed')) return 'completed';
  if (statuses.every(status => status === 'cancelled')) return 'cancelled';
  return statuses.some(status => status === 'completed') ? 'mixed' : 'failed';
};

function headline(handoff: FollowupHandoff): string {
  if (handoff.phase === 'starting') return 'Follow-up accepted. Starting a new run…';
  const many = handoff.runs.length > 1;
  switch (runOutcome(handoff.runs)) {
    case 'completed': return many ? 'The new runs completed' : 'The new run completed';
    case 'failed': return many ? 'The new runs failed' : 'The new run failed';
    case 'cancelled': return many ? 'The new runs were cancelled' : 'The new run was cancelled';
    case 'mixed': return 'The new runs finished';
    default: return many ? 'New runs are working on your follow-up' : 'A new run is working on your follow-up';
  }
}

function detail(handoff: FollowupHandoff): string {
  const thread = handoff.issueNumber ? `issue #${handoff.issueNumber}` : 'the issue';
  return handoff.phase === 'starting'
    ? `Your request was posted to ${thread}. This failed run stays as it was; the new run appears here once it starts.`
    : 'This failed run and its history stay here unchanged.';
}

const StatusIcon: React.FC<{ handoff: FollowupHandoff }> = ({ handoff }) => {
  const outcome = handoff.phase === 'starting' ? 'working' : runOutcome(handoff.runs);
  if (outcome === 'completed') return <CheckCircle2 size={16} className="mt-0.5 flex-none text-emerald-600" aria-hidden="true" />;
  if (outcome === 'failed' || outcome === 'cancelled') return <XCircle size={16} className="mt-0.5 flex-none text-red-600" aria-hidden="true" />;
  return <Loader2 size={16} className="mt-0.5 flex-none animate-spin text-teal-700 motion-reduce:animate-none" aria-hidden="true" />;
};

/**
 * Where an accepted issue follow-up went: a persistent note on the failed run
 * that sent it, waiting while the new run starts and then linking to it. The
 * link opens the run the way the timeline does (in the pane, or by route),
 * and is a real link, so it can also be opened elsewhere.
 */
const FollowupHandoffBanner: React.FC<FollowupHandoffBannerProps> = ({ handoff, onSelectRun, onDismiss }) => {
  if (!handoff) return null;
  const runs = handoff.phase === 'started' ? handoff.runs : [];
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="followup-handoff"
      data-phase={handoff.phase}
      className="flex-shrink-0 border-b border-teal-200 bg-teal-50 px-3 py-2 sm:px-4"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-2">
          <StatusIcon handoff={handoff} />
          <div className="min-w-0 text-sm">
            <p className="font-semibold text-slate-900 break-words">{headline(handoff)}</p>
            <p className="text-slate-600 break-words">{detail(handoff)}</p>
          </div>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          {runs.map((run, index) => (
            <Link
              key={run.taskId}
              to={taskPath(run.taskId)}
              data-testid="followup-handoff-view-run"
              onClick={event => {
                if (!onSelectRun || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                onSelectRun(run.taskId);
              }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-teal-700 px-3 text-sm font-medium text-white hover:bg-teal-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2"
            >
              {runs.length > 1 ? `View run ${index + 1} of ${runs.length}` : 'View new run'}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          ))}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss follow-up status"
            title="Dismiss"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-500 hover:bg-teal-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default FollowupHandoffBanner;
