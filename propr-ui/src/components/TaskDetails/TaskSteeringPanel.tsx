import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { TASK_STEER_MAX_LENGTH, TASK_STEER_SECTION_TITLE } from '@propr/shared';
import { getTaskSteering, steerTask, type TaskSteer, type TaskSteeringState } from '../../api/taskSteeringApi';

const REFRESH_INTERVAL_MS = 5_000;

interface TaskSteeringPanelProps {
  taskId?: string;
  /** Whether the task is still active; the panel stops polling once it is not. */
  isTaskActive: boolean;
  /** Set while an earlier, read-only run is inspected. */
  hidden?: boolean;
}

function deliveryLabel(steer: TaskSteer): string {
  if (steer.delivery === 'live') return steer.acknowledgedAt ? 'Delivered' : 'Delivering';
  if (steer.delivery === 'replacement_prompt') return 'In the next run prompt';
  return 'Queued';
}

/** Returns the entry only when it was recorded for the task the panel currently shows. */
function ownedBy<T extends { taskId: string }>(entry: T | null, taskId: string | undefined): T | null {
  return entry && entry.taskId === taskId ? entry : null;
}

/**
 * Steering state for the shown task. Every piece of state records the task it
 * belongs to, so a draft, history or error loaded for one task is never shown
 * or sent under another, and late responses for a previous task are dropped.
 */
function useTaskSteering(taskId: string | undefined, isTaskActive: boolean, hidden: boolean) {
  const [loaded, setLoaded] = useState<{ taskId: string; state: TaskSteeringState } | null>(null);
  const [draft, setDraft] = useState<{ taskId: string; text: string } | null>(null);
  const [sendingTaskId, setSendingTaskId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ taskId: string; message: string } | null>(null);
  const currentTaskIdRef = useRef(taskId);
  currentTaskIdRef.current = taskId;

  const refresh = useCallback(async () => {
    if (!taskId) return;
    try {
      const next = await getTaskSteering(taskId);
      // A response for a task the panel no longer shows must not replace the current task's state.
      if (currentTaskIdRef.current === taskId) setLoaded({ taskId, state: next });
    } catch {
      // The panel is optional; the live log keeps working without it.
    }
  }, [taskId]);

  useEffect(() => {
    if (hidden) return;
    void refresh();
    if (!isTaskActive) return;
    const timer = setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, isTaskActive, hidden]);

  const message = ownedBy(draft, taskId)?.text ?? '';
  const sending = Boolean(taskId) && sendingTaskId === taskId;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!taskId || !trimmed || sending) return;
    const submittedTaskId = taskId;
    setSendingTaskId(submittedTaskId);
    setFailure(null);
    try {
      await steerTask(submittedTaskId, trimmed);
      setDraft(current => (current && current.taskId === submittedTaskId ? null : current));
      if (currentTaskIdRef.current === submittedTaskId) await refresh();
    } catch (submitError) {
      if (currentTaskIdRef.current === submittedTaskId) {
        setFailure({ taskId: submittedTaskId, message: (submitError as Error).message || 'Could not send the message' });
      }
    } finally {
      setSendingTaskId(current => (current === submittedTaskId ? null : current));
    }
  };

  return {
    // Until the current task's steering state loads, nothing (in particular no send box) is shown.
    state: ownedBy(loaded, taskId)?.state ?? null,
    message,
    setMessage: (text: string) => { if (taskId) setDraft({ taskId, text }); },
    sending,
    error: ownedBy(failure, taskId)?.message ?? null,
    submit,
  };
}

/**
 * Operator steering for a running ordinary task: a message box next to the
 * live log and the messages already sent. Agents that cannot receive input
 * during a task run show why instead of the box.
 */
const TaskSteeringPanel: React.FC<TaskSteeringPanelProps> = ({ taskId, isTaskActive, hidden = false }) => {
  const { state, message, setMessage, sending, error, submit } = useTaskSteering(taskId, isTaskActive, hidden);
  const inputId = useId();
  const hintId = useId();

  if (hidden || !taskId || !state || (!state.running && state.steers.length === 0)) return null;

  const maxLength = state.maxMessageLength || TASK_STEER_MAX_LENGTH;
  const canSteer = state.running && state.capability !== 'none';
  const trimmed = message.trim();

  return (
    <section
      aria-label="Steer this run"
      data-testid="task-steering-panel"
      className="flex-shrink-0 border-t border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
    >
      {state.steers.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-zinc-400">{TASK_STEER_SECTION_TITLE}</div>
          <ul className="max-h-24 space-y-1 overflow-y-auto">
            {state.steers.map(steer => (
              <li key={steer.id} className="flex items-start gap-2">
                <span className="shrink-0 font-bold text-amber-300">YOU</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{steer.message}</span>
                <span className="shrink-0 text-zinc-400">{steer.author} · {deliveryLabel(steer)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.running && !canSteer && (
        <p className="text-zinc-400">
          The {state.agentType ?? 'running'} agent cannot receive input during a task run (steering capability: {state.capability}).
          Send a follow-up when it finishes, or stop the run.
        </p>
      )}
      {canSteer && (
        <form onSubmit={submit} className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
            Steer the running agent
          </label>
          <div className="flex items-end gap-2">
            <textarea
              id={inputId}
              aria-describedby={hintId}
              value={message}
              maxLength={maxLength}
              rows={2}
              disabled={sending}
              onChange={event => setMessage(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(event);
              }}
              placeholder="Correct the agent's direction without stopping the run"
              className="min-w-0 flex-1 resize-y rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-amber-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!trimmed || sending}
              className="inline-flex items-center gap-1 rounded bg-amber-500 px-3 py-1.5 font-semibold text-zinc-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
              Send
            </button>
          </div>
          <p id={hintId} className="text-zinc-500">
            Delivered once to the running {state.agentType ?? 'agent'} ({state.capability}). {message.length}/{maxLength} characters,
            up to {state.maxSteersPerRun} messages per run. PR comments still wait for the run to finish.
          </p>
          {error && <p role="alert" className="text-red-400">{error}</p>}
        </form>
      )}
    </section>
  );
};

export default TaskSteeringPanel;
