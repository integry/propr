import React, { useEffect, useRef, useState } from 'react';
import { AGENT_INPUT_CLASSES, AGENT_INVALID_INPUT_CLASSES, AgentFormRow } from './AgentFormRow';
import { agentFieldErrorId, scheduleErrorMessage, SCHEDULE_FIVE_PARTS_MESSAGE } from './agentFormValidation';
import { SCHEDULE_PRESETS, formatUtc, nextScheduledRun } from './agentPresentation';
import { AgentScheduleRepeatControls } from './AgentScheduleRepeatControls';
import { DEFAULT_REPEAT, type RepeatSettings, cronToRepeat, repeatToCron } from './agentScheduleRepeat';

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

const SEGMENT_CLASSES = 'touch-hit px-3 py-1 text-xs font-medium first:rounded-l-[5px] last:rounded-r-[5px] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed';

/** Keeps the "Next run" preview current while the editor stays open. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

type ScheduleMode = 'off' | 'repeat';
const MODES: readonly { mode: ScheduleMode; label: string }[] = [
  { mode: 'off', label: 'Off' },
  { mode: 'repeat', label: 'Repeat' },
];
/** How Repeat is entered: the plain controls, or the expression itself as an advanced input. */
type RepeatInput = 'simple' | 'expression';

const LINK_CLASSES = 'text-xs font-medium text-teal-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:text-slate-400';

const normalize = (expression: string) => expression.trim().split(/\s+/).join(' ');
/** The plain controls for an expression they produce (or none yet), the expression field for anything else. */
const inputOf = (expression: string): RepeatInput => (!expression.trim() || cronToRepeat(expression) ? 'simple' : 'expression');

/**
 * Off or Repeat. Repeat is built from plain controls that write the cron, or,
 * behind a secondary link, typed as the expression itself (with presets); a live
 * next-run preview and inline validation in UTC either way.
 */
export const AgentScheduleSection: React.FC<AgentScheduleSectionProps> = ({
  enabled, expression, pauseWhenUnproductive = false, onChange, disabled, unproductiveRunThreshold, error: submitError = null,
}) => {
  const now = useMinuteClock();
  const [input, setInput] = useState<RepeatInput>(() => inputOf(expression));
  const [settings, setSettings] = useState<RepeatSettings>(() => cronToRepeat(expression) ?? DEFAULT_REPEAT);
  // The last expression this section wrote; any other value came from outside (a loaded automation, a template).
  const written = useRef(expression);
  useEffect(() => {
    if (expression === written.current) return;
    written.current = expression;
    const parsed = cronToRepeat(expression);
    if (parsed) setSettings(parsed);
    setInput(inputOf(expression));
  }, [expression]);

  const mode: ScheduleMode = enabled ? 'repeat' : 'off';
  const error = enabled ? (expression.trim() ? scheduleErrorMessage(expression) : submitError) : null;
  const next = enabled && !error && expression.trim() ? nextScheduledRun(expression.trim(), now) : null;
  const feedbackId = error ? agentFieldErrorId('schedule') : 'agent-schedule-feedback';
  // The plain controls chosen for an expression they cannot show: the expression stays until a control changes.
  const keeping = enabled && input === 'simple' && expression.trim() !== '' && normalize(expression) !== repeatToCron(settings);

  const write = (schedule: string, change: { scheduleEnabled?: boolean } = {}) => {
    written.current = schedule;
    onChange({ ...change, schedule });
  };

  const choose = (choice: ScheduleMode) => {
    if (choice === 'off') {
      onChange({ scheduleEnabled: false });
      return;
    }
    if (enabled) return;
    if (!expression.trim()) {
      setInput('simple');
      write(repeatToCron(settings), { scheduleEnabled: true });
      return;
    }
    onChange({ scheduleEnabled: true });
  };

  const switchInput = (next: RepeatInput) => {
    if (next === 'simple') {
      const parsed = cronToRepeat(expression);
      if (parsed) setSettings(parsed);
    }
    setInput(next);
  };

  const changeRepeat = (changed: RepeatSettings) => {
    setSettings(changed);
    write(repeatToCron(changed));
  };

  return (
    <AgentFormRow label="Schedule" hint="Times are UTC. Off: it runs only when started.">
      <div role="radiogroup" aria-label="Schedule" className="inline-flex rounded-md border border-slate-300">
        {MODES.map(({ mode: value, label }, index) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            disabled={disabled}
            onClick={() => choose(value)}
            className={`${SEGMENT_CLASSES} ${index ? 'border-l border-slate-300' : ''} ${mode === value ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {enabled && (
        <div className="mt-3 space-y-2">
          {input === 'simple' ? (
            <>
              <AgentScheduleRepeatControls settings={settings} onChange={changeRepeat} disabled={disabled} invalid={Boolean(error)} describedBy={feedbackId} />
              {keeping && (
                <p className="text-xs text-slate-500" data-testid="agent-schedule-kept">
                  Keeps <span className="font-mono text-slate-700">{expression.trim()}</span> until you change a control.
                </p>
              )}
              <button type="button" disabled={disabled} onClick={() => switchInput('expression')} className={LINK_CLASSES}>
                Use a cron expression
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input
                  id="agent-schedule"
                  aria-label="Cron expression"
                  value={expression}
                  disabled={disabled}
                  onChange={event => write(event.target.value)}
                  placeholder="0 9 * * 1-5"
                  spellCheck={false}
                  aria-invalid={Boolean(error)}
                  aria-describedby={feedbackId}
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
                    onClick={() => write(preset.expression)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${expression.trim() === preset.expression ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <button type="button" disabled={disabled} onClick={() => switchInput('simple')} className={LINK_CLASSES}>
                Use simple schedule
              </button>
            </>
          )}
          <p id={feedbackId} className="text-xs" data-testid="agent-schedule-feedback">
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
