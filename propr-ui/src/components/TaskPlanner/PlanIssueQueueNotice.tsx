import React from 'react';
import { AlertTriangle, Loader2, Play, RotateCcw, SkipForward } from 'lucide-react';
import type { PlanExecutionQueueIssue } from '../../api/planIssuesApi';
import { describeBlocked, issueList, skipLabel } from './planQueueLabels';
import type { PlanQueueAction } from './usePlanQueueActions';

interface PlanIssueQueueNoticeProps {
  state: PlanExecutionQueueIssue;
  /** Graph issues that depend on this one; a skip can release them. */
  dependents?: number[];
  pendingAction?: PlanQueueAction | null;
  disabled?: boolean;
  /** Absent for a read-only plan: a blocker is still explained, without actions. */
  onAction?: (action: PlanQueueAction) => void;
}

const ActionButton: React.FC<{ label: string; icon: React.ReactNode; busy: boolean; disabled: boolean; onClick: () => void; testId: string; tone?: 'primary' | 'quiet' }> = ({
  label, icon, busy, disabled, onClick, testId, tone = 'quiet',
}) => (
  <button
    type="button"
    data-testid={testId}
    disabled={disabled}
    onClick={(event) => { event.stopPropagation(); onClick(); }}
    className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
      tone === 'primary' ? 'border-amber-300 bg-white text-amber-800 hover:bg-amber-100' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
  >
    {busy ? <Loader2 size={12} className="animate-spin" /> : icon}
    {label}
  </button>
);

/** Which blocker holds the issue and why; `actions` is absent for a read-only plan. */
const BlockedNotice: React.FC<{ state: PlanExecutionQueueIssue; actions: React.ReactNode }> = ({ state, actions }) => {
  const { title, detail, inProgress } = describeBlocked(state);
  return (
    <div role="status" data-testid="plan-queue-blocked" className="mt-2 flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 xl:flex-row xl:items-start xl:justify-between">
      <div className="flex min-w-0 items-start gap-2 text-xs text-amber-900">
        {inProgress
          ? <Loader2 size={14} className="mt-0.5 flex-shrink-0 animate-spin text-amber-600" aria-hidden />
          : <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-600" aria-hidden />}
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          {detail && <p className="mt-0.5 break-words text-amber-800">{detail}</p>}
        </div>
      </div>
      {actions}
    </div>
  );
};

/**
 * How an issue stands in the plan's execution queue when a person may need to act:
 * which blocker holds it and why (with Retry and Skip), a skipped issue (which the queue
 * does not run again, and whose graph dependents may still wait on it), or a pending issue
 * waiting on a skipped prerequisite. Without `onAction` (a read-only plan) only the blocker
 * explanation is shown.
 */
export const PlanIssueQueueNotice: React.FC<PlanIssueQueueNoticeProps> = ({ state, dependents = [], pendingAction = null, disabled = false, onAction }) => {
  const busy = pendingAction !== null;
  const button = (action: PlanQueueAction, label: string, icon: React.ReactNode, tone?: 'primary' | 'quiet') => (
    <ActionButton key={action} testId={`plan-queue-${action}`} label={label} icon={icon} tone={tone}
      busy={pendingAction === action} disabled={disabled || busy} onClick={() => onAction?.(action)} />
  );
  if (state.state === 'blocked') {
    return <BlockedNotice state={state} actions={onAction ? (
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
        {state.blockedKind !== 'setup_not_ready' && button('retry', 'Retry', <RotateCcw size={12} />, 'primary')}
        {button('skip', skipLabel(dependents), <SkipForward size={12} />)}
        {dependents.length > 0 && button('skip_release', `Skip and start ${issueList(dependents)}`, <SkipForward size={12} />)}
      </div>
    ) : null} />;
  }
  // The other notices are offers to act; a read-only plan has none.
  if (!onAction) return null;
  if (state.state === 'skipped') {
    // The queue has no un-skip: a skipped issue stays out of this execution.
    const waiting = state.skipSatisfiesDependents === false ? dependents : [];
    return (
      <div data-testid="plan-queue-skipped" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        <span className="min-w-0">
          Skipped. The queue does not run it again in this execution.
          {waiting.length > 0 && ` ${issueList(waiting)} ${waiting.length === 1 ? 'waits' : 'wait'} on it.`}
        </span>
        {waiting.length > 0 && button('skip_release', `Start ${issueList(waiting)}`, <Play size={12} />)}
      </div>
    );
  }
  if (state.state === 'pending') {
    // A queued issue can be skipped before its turn; it never starts then.
    const waitingOnSkipped = state.waitingOnSkipped ?? [];
    return (
      <div data-testid="plan-queue-pending" className="mt-1 flex flex-wrap items-center justify-end gap-2 text-xs text-slate-600">
        {waitingOnSkipped.length > 0 && (
          <span data-testid="plan-queue-waiting-skipped" className="mr-auto">
            Waiting on skipped {issueList(waitingOnSkipped)}. Start it from that row.
          </span>
        )}
        {button('skip', skipLabel(dependents), <SkipForward size={12} />)}
      </div>
    );
  }
  return null;
};

export default PlanIssueQueueNotice;
