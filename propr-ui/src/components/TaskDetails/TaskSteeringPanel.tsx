import React, { useCallback, useEffect, useId, useState } from 'react';
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

/**
 * Operator steering for a running ordinary task: a message box next to the
 * live log and the messages already sent. Agents that cannot receive input
 * during a task run show why instead of the box.
 */
const TaskSteeringPanel: React.FC<TaskSteeringPanelProps> = ({ taskId, isTaskActive, hidden = false }) => {
  const [state, setState] = useState<TaskSteeringState | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();

  const refresh = useCallback(async () => {
    if (!taskId) return;
    try {
      setState(await getTaskSteering(taskId));
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

  if (hidden || !taskId || !state || (!state.running && state.steers.length === 0)) return null;

  const maxLength = state.maxMessageLength || TASK_STEER_MAX_LENGTH;
  const canSteer = state.running && state.capability !== 'none';
  const trimmed = message.trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await steerTask(taskId, trimmed);
      setMessage('');
      await refresh();
    } catch (submitError) {
      setError((submitError as Error).message || 'Could not send the message');
    } finally {
      setSending(false);
    }
  };

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
