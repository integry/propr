import React, { useEffect, useState } from 'react';
import { AGENT_INPUT_CLASSES, AGENT_INVALID_INPUT_CLASSES, AgentFormRow } from './AgentFormRow';
import { agentFieldErrorId, scheduleErrorMessage, SCHEDULE_FIVE_PARTS_MESSAGE } from './agentFormValidation';
import { SCHEDULE_PRESETS, formatUtc, nextScheduledRun } from './agentPresentation';

interface AgentScheduleSectionProps {
  enabled: boolean;
  expression: string;
  /** Turn the schedule off when the unproductive-run notification fires. */
  pauseWhenUnproductive?: boolean;
  onChange: (change: { scheduleEnabled?: boolean; schedule?: string; pauseWhenUnproductive?: boolean }) => void;
  disabled: boolean;
  /** Runs in a row with nothing new before the Inbox notice, from the instance setting; null when it cannot be read, and the label names no number. */
  unproductiveRunThreshold: number | null;
  /** The error a refused save found; an expression being typed is checked as it changes. */
  error?: string | null;
}

const SEGMENT_CLASSES = 'px-3 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed';

/** Keeps the "Next run" preview current while the editor stays open. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Off, or a UTC cron expression with presets, a live next-run preview and inline validation. */
export const AgentScheduleSection: React.FC<AgentScheduleSectionProps> = ({
  enabled, expression, pauseWhenUnproductive = false, onChange, disabled, unproductiveRunThreshold, error: submitError = null,
}) => {
  const now = useMinuteClock();
  const error = enabled ? (expression.trim() ? scheduleErrorMessage(expression) : submitError) : null;
  const next = enabled && !error && expression.trim() ? nextScheduledRun(expression.trim(), now) : null;

  return (
    <AgentFormRow label="Schedule" hint="Runs on a cron schedule in UTC. Off: it runs only when started.">
      <div role="radiogroup" aria-label="Schedule" className="inline-flex overflow-hidden rounded-md border border-slate-300">
        {([false, true] as const).map(value => (
          <button
            key={String(value)}
            type="button"
            role="radio"
            aria-checked={enabled === value}
            disabled={disabled}
            onClick={() => onChange({ scheduleEnabled: value })}
            className={`${SEGMENT_CLASSES} ${value ? 'border-l border-slate-300' : ''} ${enabled === value ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            {value ? 'Cron' : 'Off'}
          </button>
        ))}
      </div>

      {enabled && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              id="agent-schedule"
              aria-label="Cron expression"
              value={expression}
              disabled={disabled}
              onChange={event => onChange({ schedule: event.target.value })}
              placeholder="0 9 * * 1-5"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? agentFieldErrorId('schedule') : 'agent-schedule-feedback'}
              className={`${error ? AGENT_INVALID_INPUT_CLASSES : AGENT_INPUT_CLASSES} font-mono`}
            />
            <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">UTC</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SCHEDULE_PRESETS.map(preset => (
              <button
                key={preset.expression}
                type="button"
                disabled={disabled}
                onClick={() => onChange({ schedule: preset.expression })}
                className={`rounded-full border px-2.5 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${expression.trim() === preset.expression ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p id={error ? agentFieldErrorId('schedule') : 'agent-schedule-feedback'} className="text-xs" data-testid="agent-schedule-feedback">
            {error
              ? <span className="font-medium text-red-700">{error}</span>
              : next
                ? <span className="text-slate-600">Next run: <span className="font-mono text-slate-800">{formatUtc(next)}</span></span>
                : <span className="text-slate-500">{SCHEDULE_FIVE_PARTS_MESSAGE.replace('Enter', 'Pick a preset or enter')}</span>}
          </p>
          <label className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 text-sm text-slate-800">
            <input
              type="checkbox"
              data-testid="agent-pause-when-unproductive"
              checked={pauseWhenUnproductive}
              disabled={disabled}
              onChange={event => onChange({ pauseWhenUnproductive: event.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus-visible:ring-2 focus-visible:ring-teal-500"
            />
            <span>
              {unproductiveRunThreshold === null
                ? 'Pause the schedule when runs in a row keep finding nothing new'
                : `Pause the schedule after ${unproductiveRunThreshold} runs in a row with nothing new`}
              <span className="block text-xs text-slate-500">You get an Inbox notice either way.</span>
            </span>
          </label>
        </div>
      )}
    </AgentFormRow>
  );
};
