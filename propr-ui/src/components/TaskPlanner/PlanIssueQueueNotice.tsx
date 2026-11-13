import React from 'react';
import { AlertTriangle, Loader2, RotateCcw, SkipForward } from 'lucide-react';
import type { PlanExecutionQueueIssue } from '../../api/planIssuesApi';
import { BLOCKED_KIND_LABELS } from './planQueueLabels';
import type { PlanQueueAction } from './usePlanQueueActions';

interface PlanIssueQueueNoticeProps {
  state: PlanExecutionQueueIssue;
  /** Graph issues that depend on this one; a skip can release them. */
  dependents?: number[];
  pendingAction?: PlanQueueAction | null;
  disabled?: boolean;
  onAction: (action: PlanQueueAction) => void;
}

const issueList = (issues: number[]) => issues.map(issue => `#${issue}`).join(', ');

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

/**
 * How an issue stands in the plan's execution queue when a person may need to act:
 * which blocker holds it and why (with Retry and Skip), a skipped issue whose graph
 * dependents still wait, or a pending issue waiting on a skipped prerequisite.
 */
export const PlanIssueQueueNotice: React.FC<PlanIssueQueueNoticeProps> = ({ state, dependents = [], pendingAction = null, disabled = false, onAction }) => {
  const busy = pendingAction !== null;
  const button = (action: PlanQueueAction, label: string, icon: React.ReactNode, tone?: 'primary' | 'quiet') => (
    <ActionButton key={action} testId={`plan-queue-${action}`} label={label} icon={icon} tone={tone}
      busy={pendingAction === action} disabled={disabled || busy} onClick={() => onAction(action)} />
  );
  if (state.state === 'blocked') {
    const kind = state.blockedKind;
    return (
      <div role="status" data-testid="plan-queue-blocked" className="mt-2 flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2 text-xs text-amber-900">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-600" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold">Blocked{kind ? ` · ${BLOCKED_KIND_LABELS[kind] ?? kind}` : ''}</p>
            {state.blockedReason && <p className="mt-0.5 break-words text-amber-800">{state.blockedReason}</p>}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
          {kind !== 'setup_not_ready' && button('retry', 'Retry', <RotateCcw size={12} />, 'primary')}
          {button('skip', 'Skip', <SkipForward size={12} />)}
          {dependents.length > 0 && button('skip_release', `Skip and start ${issueList(dependents)}`, <SkipForward size={12} />)}
        </div>
      </div>
    );
  }
  if (state.state === 'skipped' && dependents.length > 0 && state.skipSatisfiesDependents === false) {
    return (
      <div data-testid="plan-queue-skipped" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        <span>Skipped. {issueList(dependents)} {dependents.length === 1 ? 'waits' : 'wait'} on it until you release {dependents.length === 1 ? 'it' : 'them'}.</span>
        {button('skip_release', 'Release dependents', <SkipForward size={12} />)}
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
            Waiting on skipped {issueList(waitingOnSkipped)}. Release {waitingOnSkipped.length === 1 ? 'it' : 'them'} to start this issue.
          </span>
        )}
        {button('skip', 'Skip', <SkipForward size={12} />)}
      </div>
    );
  }
  return null;
};

export default PlanIssueQueueNotice;
