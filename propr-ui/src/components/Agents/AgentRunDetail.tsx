import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import type { AgentRunRecord } from '../../api/agentDefinitionsApi';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';
import { ListSkeleton } from '../ui/Skeleton';
import { SystemAlert } from '../ui/SystemAlert';
import { AgentConfirmDialog } from './AgentConfirmDialog';
import { AgentRunApprovalPanel } from './AgentRunApprovalPanel';
import { AgentRunStateBadge } from './AgentRunStateBadge';
import { AUTONOMY_BADGE_CLASSES, AUTONOMY_LABELS } from './agentPresentation';
import { CANCELLABLE_RUN_STATES, RUN_TRIGGER_LABELS, formatTimestamp, isTerminalRunState } from './agentRunPresentation';
import { useAgentRun } from './useAgentRun';

interface AgentRunDetailProps {
  definitionId: string;
  runId: string;
  agentName: string;
  /** The agent's repositories, for the approval explanation when the run carries no snapshot. */
  repositories?: readonly string[];
  /** Demo mode: decisions and cancellation are unavailable. */
  readOnly?: boolean;
}

const SECONDARY_BUTTON = 'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-50';
const TASK_LINK = 'inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:underline';

/** Why the run did not go ahead or did not finish, worded by the server (cost-gate messages included). */
function runReason(run: AgentRunRecord): { title: string; message: string } | null {
  if (run.state === 'failed' && run.failureReason) return { title: 'Run failed', message: run.failureReason };
  if (run.state === 'skipped' && run.skipReason) return { title: 'Run skipped', message: run.skipReason };
  if (run.state === 'awaiting_approval' && run.skipReason) return { title: 'Automatic acting paused for approval', message: run.skipReason };
  if (run.state === 'deferred') {
    const until = run.deferredUntil !== null ? ` until ${formatTimestamp(run.deferredUntil)}` : '';
    return { title: `Run deferred${until}`, message: run.skipReason ?? 'The run will be retried automatically.' };
  }
  if (run.failureReason) return { title: 'Run failed', message: run.failureReason };
  return null;
}

const Timestamp: React.FC<{ label: string; value: number | null }> = ({ label, value }) => (
  <div>
    <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
    <dd className="mt-0.5 text-sm text-slate-800">{formatTimestamp(value)}</dd>
  </div>
);

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
  };
  return (
    <button type="button" onClick={copy} className={SECONDARY_BUTTON}>
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
};

/** Why a run shows no report: not written yet, never written, or empty. */
const missingReportText = (run: AgentRunRecord): string => {
  if (run.reportedAt !== null) return 'This run produced an empty report.';
  return isTerminalRunState(run.state) ? 'This run ended without a report.' : 'The report appears here once the agent has written it.';
};

const AgentRunReport: React.FC<{ run: AgentRunRecord }> = ({ run }) => (
  <section aria-labelledby="agent-run-report-title" className="rounded-lg border border-slate-200 bg-white">
    <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2">
      <h2 id="agent-run-report-title" className="text-sm font-semibold text-slate-900">Report</h2>
      {run.report && <CopyButton text={run.report} />}
    </header>
    <div className="px-4 py-3 text-sm" data-testid="agent-run-report">
      {run.report
        ? <MarkdownRenderer text={run.report} />
        : <p className="text-slate-500">{missingReportText(run)}</p>}
      {run.reportTruncated && (
        <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Report truncated — full output in the task log.</p>
      )}
    </div>
  </section>
);

/** State, trigger, autonomy and timeline of a run, with its actions on the right. */
const AgentRunHeader: React.FC<{ run: AgentRunRecord; actions?: React.ReactNode }> = ({ run, actions }) => (
  <header className="space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <AgentRunStateBadge state={run.state} data-testid="agent-run-state" />
        <span className="text-sm text-slate-700" title={run.triggerSource ?? undefined}>
          {RUN_TRIGGER_LABELS[run.trigger]}
          {run.triggerSource && <span className="text-slate-500"> · {run.triggerSource}</span>}
        </span>
        <span className={`rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${AUTONOMY_BADGE_CLASSES[run.autonomyMode]}`} title="Autonomy mode used by this run">
          {AUTONOMY_LABELS[run.autonomyMode]}
        </span>
      </div>
      {actions}
    </div>
    <dl className="grid grid-cols-3 gap-3">
      <Timestamp label="Created" value={run.createdAt} />
      <Timestamp label="Reported" value={run.reportedAt} />
      <Timestamp label="Finished" value={run.finishedAt} />
    </dl>
  </header>
);

/** The acting step's summary, once the run is acting or has acted. */
const AgentRunAction: React.FC<{ run: AgentRunRecord }> = ({ run }) => {
  const shown = run.state === 'acting' || run.actionSummary !== null || run.actionTaskId !== null;
  if (!shown) return null;
  return (
    <section aria-labelledby="agent-run-action-title" className="rounded-lg border border-slate-200 bg-white">
      <h2 id="agent-run-action-title" className="border-b border-slate-200 px-4 py-2 text-sm font-semibold text-slate-900">What the acting agent did</h2>
      <div className="px-4 py-3 text-sm" data-testid="agent-run-action-summary">
        {run.actionSummary
          ? <MarkdownRenderer text={run.actionSummary} />
          : <p className="text-slate-500">{run.state === 'acting' ? 'The acting agent is working; its summary appears here when it finishes.' : 'No summary was recorded.'}</p>}
      </div>
    </section>
  );
};

/** The report and acting steps are ordinary tasks; their live output, cost and logs live on the task page. */
const AgentRunTaskLinks: React.FC<{ run: AgentRunRecord }> = ({ run }) => {
  if (!run.reportTaskId && !run.actionTaskId) return null;
  return (
    <nav aria-label="Run tasks" className="flex flex-wrap gap-4">
      {run.reportTaskId && (
        <Link to={`/tasks/${encodeURIComponent(run.reportTaskId)}`} className={TASK_LINK}>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Open report task
        </Link>
      )}
      {run.actionTaskId && (
        <Link to={`/tasks/${encodeURIComponent(run.actionTaskId)}`} className={TASK_LINK}>
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Open acting task
        </Link>
      )}
    </nav>
  );
};

/**
 * One run of an agent: its state and timeline, the reason it was skipped,
 * deferred or failed, the Markdown report, the approval decision for preview
 * mode and what the acting agent did. The report and acting steps are
 * ordinary tasks, so their live output and logs are a link away rather than
 * repeated here.
 */
export const AgentRunDetail: React.FC<AgentRunDetailProps> = ({ definitionId, runId, agentName, repositories = [], readOnly = false }) => {
  useDocumentTitle(`Run · ${agentName}`);
  const { run, foreignDefinitionId, loadError, actionError, pendingAction, reload, act } = useAgentRun(definitionId, runId);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  if (foreignDefinitionId !== null) {
    return (
      <div className="space-y-4 p-4">
        <SystemAlert>
          <p>This run belongs to a different automation, so it is not shown under {agentName}.</p>
          <Link
            to={`/automations/${encodeURIComponent(foreignDefinitionId)}/runs/${encodeURIComponent(runId)}`}
            className="mt-1 inline-block font-medium underline"
          >
            Open it under its own automation
          </Link>
        </SystemAlert>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="space-y-4 p-4">
        {loadError
          ? <SystemAlert onRetry={reload}>{loadError}</SystemAlert>
          : <ListSkeleton layout="block" rows={4} label="Loading run…" />}
      </div>
    );
  }

  const reason = runReason(run);
  const cancellable = CANCELLABLE_RUN_STATES.includes(run.state);

  return (
    <div className="space-y-4 p-4" data-testid="agent-run-detail">
      <AgentRunHeader
        run={run}
        actions={cancellable && (
          <button type="button" onClick={() => setConfirmingCancel(true)} disabled={readOnly || pendingAction !== null} className={`${SECONDARY_BUTTON} flex-none`}>
            {pendingAction === 'cancel' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Ban className="h-3.5 w-3.5" aria-hidden="true" />}
            Cancel run
          </button>
        )}
      />

      {reason && (
        <SystemAlert>
          <p className="font-semibold">{reason.title}</p>
          <p className="mt-1 whitespace-pre-wrap font-normal" data-testid="agent-run-reason">{reason.message}</p>
        </SystemAlert>
      )}
      {actionError && <SystemAlert>{actionError}</SystemAlert>}

      {run.state === 'awaiting_approval' && (
        <AgentRunApprovalPanel
          repositories={run.definitionSnapshot?.repositories ?? repositories}
          pending={pendingAction === 'approve' || pendingAction === 'reject' ? pendingAction : null}
          disabled={readOnly || pendingAction === 'cancel'}
          onApprove={note => act('approve', note)}
          onReject={() => act('reject')}
        />
      )}

      <AgentRunReport run={run} />

      <AgentRunAction run={run} />
      <AgentRunTaskLinks run={run} />

      {confirmingCancel && (
        <AgentConfirmDialog
          title="Cancel this run?"
          confirmLabel="Cancel run"
          cancelLabel="Keep run"
          tone="danger"
          busy={pendingAction === 'cancel'}
          onCancel={() => setConfirmingCancel(false)}
          onConfirm={() => void act('cancel').then(() => setConfirmingCancel(false))}
        >
          <p>Any task the run started is stopped, and the run ends as cancelled.</p>
        </AgentConfirmDialog>
      )}
    </div>
  );
};

export default AgentRunDetail;
