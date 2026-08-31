import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { GoalDetail, GoalMessage, SendGoalMessageParams } from '../../api/goalsApi';
import { GOAL_TERMINAL_STATES } from './goalDetailUtils';

interface GoalControlsProps {
  detail: GoalDetail;
  models: string[];
  readOnly: boolean;
  pendingAction: string | null;
  onPause: () => Promise<boolean>;
  onResume: () => Promise<boolean>;
  onCancel: (reason: string) => Promise<boolean>;
  onChangeModel: (model: string) => Promise<boolean>;
  onSend: (params: SendGoalMessageParams) => Promise<boolean>;
  onRetryMessage: (message: GoalMessage) => Promise<boolean>;
  onCancelMessage: (messageId: string) => Promise<void>;
}

const stateTone: Record<GoalMessage['state'], string> = {
  pending: 'bg-amber-100 text-amber-800', delivered: 'bg-blue-100 text-blue-800', acknowledged: 'bg-teal-100 text-teal-800',
  failed: 'bg-red-100 text-red-800', cancelled: 'bg-gray-100 text-gray-600',
};

function CancelConfirmation({ busy, returnFocus, onClose, onConfirm }: { busy: boolean; returnFocus: RefObject<HTMLButtonElement | null>; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('Cancelled by operator');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = returnFocus.current;
    cancelRef.current?.focus();
    return () => trigger?.focus();
  }, [returnFocus]);
  useEffect(() => { if (busy) reasonRef.current?.focus(); }, [busy]);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault(); onClose(); return;
    }
    if (event.key !== 'Tab') return;
    if (busy) { event.preventDefault(); reasonRef.current?.focus(); return; }
    if (event.shiftKey && document.activeElement === reasonRef.current) { event.preventDefault(); confirmRef.current?.focus(); }
    else if (!event.shiftKey && document.activeElement === confirmRef.current) { event.preventDefault(); reasonRef.current?.focus(); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="cancel-goal-title" aria-describedby="cancel-goal-description" onKeyDown={handleKeyDown} className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h2 id="cancel-goal-title" className="text-lg font-semibold text-slate-900">Cancel this goal?</h2>
        <p id="cancel-goal-description" className="mt-2 text-sm text-slate-600">Cancellation is terminal and distinct from pausing. Active work will be stopped at the controller boundary.</p>
        <label className="mt-4 block text-sm font-medium text-slate-700">Cancellation reason<input ref={reasonRef} value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500" /></label>
        <div className="mt-5 flex justify-end gap-2"><button ref={cancelRef} type="button" onClick={onClose} disabled={busy} className="rounded border border-slate-300 px-3 py-2 text-sm">Keep running</button><button ref={confirmRef} type="button" onClick={() => onConfirm(reason.trim())} disabled={busy || !reason.trim()} className="rounded bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Cancelling…' : 'Cancel goal'}</button></div>
      </div>
    </div>
  );
}

function GoalMessages({ messages, disabled, busy, onSend, onRetry, onCancel }: {
  messages: GoalMessage[]; disabled: boolean; busy: boolean;
  onSend: (params: SendGoalMessageParams) => Promise<boolean>;
  onRetry: (message: GoalMessage) => Promise<boolean>;
  onCancel: (messageId: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const submit = async (params: SendGoalMessageParams) => { if (await onSend(params)) setBody(''); };
  return (
    <section aria-labelledby="goal-messages-title" className="mt-4 border-t border-slate-200 pt-4">
      <h3 id="goal-messages-title" className="text-sm font-semibold text-slate-800">Steer the goal</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => void submit({ body: "Summarize what's done.", predefinedKind: 'whats_done' })} disabled={disabled || busy} className="rounded border border-slate-300 px-2.5 py-1.5 text-xs disabled:opacity-50">What’s done?</button>
        <button type="button" onClick={() => void submit({ body: "Summarize what's left.", predefinedKind: 'whats_left' })} disabled={disabled || busy} className="rounded border border-slate-300 px-2.5 py-1.5 text-xs disabled:opacity-50">What’s left?</button>
      </div>
      <form className="mt-2" onSubmit={event => { event.preventDefault(); void submit({ body: body.trim() }); }}>
        <label htmlFor="goal-message" className="sr-only">Message to the goal controller</label>
        <textarea id="goal-message" value={body} maxLength={4000} onChange={event => setBody(event.target.value)} disabled={disabled || busy} rows={3} placeholder="Send guidance at the next safe boundary…" className="w-full resize-y rounded border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:bg-slate-100" />
        <div className="mt-1 flex items-center justify-between"><span className="text-[10px] text-slate-400">{Array.from(body).length}/4000</span><button type="submit" disabled={disabled || busy || !body.trim()} className="rounded bg-teal-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{busy ? 'Sending…' : 'Send message'}</button></div>
      </form>
      <ol aria-label="Goal messages" className="mt-3 max-h-72 space-y-2 overflow-y-auto">
        {messages.map(message => <li key={message.messageId} className="rounded border border-slate-200 p-2 text-xs">
          <div className="flex items-start gap-2"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-700">{message.body}</p><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${stateTone[message.state]}`}>{message.state}</span></div>
          {message.response && <p className="mt-1 rounded bg-slate-50 p-1.5 text-slate-600"><span className="font-medium capitalize">{message.responseSource} response:</span> {message.response}</p>}
          {message.error && <p className="mt-1 text-red-700">{message.error}</p>}
          {(message.state === 'failed' || message.state === 'pending') && <div className="mt-1.5 flex gap-2">{message.state === 'failed' && <button type="button" onClick={() => void onRetry(message)} disabled={disabled || busy} className="font-medium text-teal-700 disabled:opacity-50">Retry</button>}{message.state === 'pending' && <button type="button" onClick={() => void onCancel(message.messageId)} disabled={disabled || busy} className="font-medium text-slate-500 disabled:opacity-50">Cancel pending message</button>}</div>}
        </li>)}
      </ol>
    </section>
  );
}

function LifecycleControls({ state, disabled, pendingAction, cancelTriggerRef, onPause, onResume, onOpenCancel }: {
  state: GoalDetail['goal']['state']; disabled: boolean; pendingAction: string | null;
  cancelTriggerRef: RefObject<HTMLButtonElement | null>;
  onPause: () => Promise<boolean>; onResume: () => Promise<boolean>; onOpenCancel: () => void;
}) {
  const terminal = GOAL_TERMINAL_STATES.has(state);
  const pausable = state === 'running' || state === 'planning' || state === 'recovering' || state === 'pausing';
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {pausable && <button type="button" onClick={() => void onPause()} disabled={disabled || state === 'pausing'} title={state === 'pausing' ? 'Waiting for the runtime safe boundary' : undefined} className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 disabled:opacity-50">{state === 'pausing' ? 'Pausing…' : pendingAction === 'pause' ? 'Requesting pause…' : 'Pause'}</button>}
      {state === 'paused' && <button type="button" onClick={() => void onResume()} disabled={disabled} className="rounded bg-teal-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{pendingAction === 'resume' ? 'Resuming…' : 'Resume'}</button>}
      {!terminal && <button ref={cancelTriggerRef} type="button" onClick={onOpenCancel} disabled={disabled} className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50">Cancel goal…</button>}
    </div>
  );
}

export default function GoalControls(props: GoalControlsProps) {
  const { detail, models, readOnly, pendingAction, onPause, onResume, onCancel, onChangeModel } = props;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const [selectedModel, setSelectedModel] = useState(detail.goal.requestedModel);
  const terminal = GOAL_TERMINAL_STATES.has(detail.goal.state);
  const controlsDisabled = readOnly || terminal || pendingAction !== null;
  useEffect(() => { setSelectedModel(detail.goal.requestedModel); }, [detail.goal.requestedModel]);
  return (
    <section aria-labelledby="goal-controls-title" className="rounded-lg border border-slate-200 bg-white p-3">
      <h2 id="goal-controls-title" className="text-sm font-semibold text-slate-800">Controls</h2>
      {(readOnly || terminal) && <p className="mt-1 text-xs text-amber-700">{readOnly ? 'Controls are unavailable in demo/read-only mode or after access loss.' : 'This goal is terminal. Lifecycle, model, and steering operations no longer apply.'}</p>}
      <LifecycleControls state={detail.goal.state} disabled={controlsDisabled} pendingAction={pendingAction} cancelTriggerRef={cancelTriggerRef} onPause={onPause} onResume={onResume} onOpenCancel={() => setConfirmCancel(true)} />
      <div className="mt-4 border-t border-slate-200 pt-3">
        <label htmlFor="goal-model" className="text-xs font-medium text-slate-700">Requested model</label>
        <div className="mt-1 flex gap-2"><select id="goal-model" value={selectedModel} onChange={event => setSelectedModel(event.target.value)} disabled={controlsDisabled || models.length === 0} className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1.5 text-xs disabled:bg-slate-100">{models.length === 0 && <option value={detail.goal.requestedModel}>{detail.goal.requestedModel}</option>}{models.map(model => <option key={model}>{model}</option>)}</select><button type="button" onClick={() => void onChangeModel(selectedModel)} disabled={controlsDisabled || selectedModel === detail.goal.requestedModel || !models.includes(selectedModel)} className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50">Request change</button></div>
        <p className="mt-1 text-[11px] text-slate-500">Effective: <span className="font-medium">{detail.goal.effectiveModel}</span>{detail.goal.requestedModel !== detail.goal.effectiveModel && <span className="ml-1 text-blue-700">· {detail.goal.requestedModel} requested, awaiting runtime acknowledgement</span>}</p>
      </div>
      <GoalMessages messages={detail.messages} disabled={readOnly || terminal} busy={pendingAction === 'message' || pendingAction === 'cancel-message'} onSend={props.onSend} onRetry={props.onRetryMessage} onCancel={props.onCancelMessage} />
      {confirmCancel && <CancelConfirmation busy={pendingAction === 'cancel'} returnFocus={cancelTriggerRef} onClose={() => setConfirmCancel(false)} onConfirm={reason => { void onCancel(reason).then(success => { if (success) setConfirmCancel(false); }); }} />}
    </section>
  );
}
