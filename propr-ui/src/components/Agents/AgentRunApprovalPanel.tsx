import React, { useState } from 'react';
import { Check, ShieldCheck, X } from 'lucide-react';
import { AGENT_ACTION_OPERATOR_NOTE_MAX_CHARS } from '@propr/shared';
import { AgentConfirmDialog } from './AgentConfirmDialog';
import { repoShortName } from './agentPresentation';

interface AgentRunApprovalPanelProps {
  repositories: readonly string[];
  /** Which decision is being sent, if any. */
  pending: 'approve' | 'reject' | null;
  disabled?: boolean;
  onApprove: (note: string) => Promise<boolean>;
  onReject: () => Promise<boolean>;
}

const BUTTON_CLASSES = 'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * A preview-mode run waits here for a person: approving starts the acting
 * step with the optional note as extra guidance, rejecting ends the run with
 * the report alone. Both ask for confirmation first.
 */
export const AgentRunApprovalPanel: React.FC<AgentRunApprovalPanelProps> = ({ repositories, pending, disabled = false, onApprove, onReject }) => {
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const busy = pending !== null;
  const scope = repositories.length > 0 ? repositories.map(repoShortName).join(', ') : "this automation's repositories";

  const confirm = async () => {
    const ok = confirming === 'approve' ? await onApprove(note.trim()) : await onReject();
    if (ok) setNote('');
    setConfirming(null);
  };

  return (
    <section aria-labelledby="agent-run-approval-title" className="rounded-lg border border-amber-300 bg-amber-50/60 p-4" data-testid="agent-run-approval">
      <h2 id="agent-run-approval-title" className="flex items-center gap-2 text-sm font-semibold text-amber-900">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />Awaiting your approval
      </h2>
      <p className="mt-1.5 text-sm text-amber-900/90">
        Approving starts the acting agent on this report. It can use ProPR tools on {scope} — for example opening issues,
        starting tasks or commenting — but it cannot merge pull requests or change settings.
      </p>
      <label htmlFor="agent-run-note" className="mt-3 block text-xs font-medium text-slate-700">Note for the acting agent (optional)</label>
      <textarea
        id="agent-run-note"
        value={note}
        onChange={event => setNote(event.target.value)}
        maxLength={AGENT_ACTION_OPERATOR_NOTE_MAX_CHARS}
        rows={3}
        disabled={disabled || busy}
        placeholder="Only act on the first two findings."
        className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:bg-slate-50"
      />
      <p className="mt-1 text-right text-[11px] tabular-nums text-slate-500">{note.length.toLocaleString()} / {AGENT_ACTION_OPERATOR_NOTE_MAX_CHARS.toLocaleString()}</p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => setConfirming('reject')}
          disabled={disabled || busy}
          className={`${BUTTON_CLASSES} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-teal-500`}
        >
          <X className="h-4 w-4" aria-hidden="true" />Reject
        </button>
        <button
          type="button"
          onClick={() => setConfirming('approve')}
          disabled={disabled || busy}
          className={`${BUTTON_CLASSES} bg-teal-600 text-white hover:bg-teal-700 focus-visible:ring-teal-500`}
        >
          <Check className="h-4 w-4" aria-hidden="true" />Approve and act
        </button>
      </div>

      {confirming && (
        <AgentConfirmDialog
          title={confirming === 'approve' ? 'Approve and act?' : 'Reject this run?'}
          confirmLabel={confirming === 'approve' ? 'Approve and act' : 'Reject'}
          tone={confirming === 'approve' ? 'primary' : 'danger'}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void confirm()}
        >
          {confirming === 'approve'
            ? <p>The acting agent will start now and use ProPR tools on {scope}{note.trim() ? ', with your note' : ''}.</p>
            : <p>The run ends with its report only; nothing will be acted on.</p>}
        </AgentConfirmDialog>
      )}
    </section>
  );
};

export default AgentRunApprovalPanel;
