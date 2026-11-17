import React from 'react';
import { type RepeatSettings, type RepeatUnit, REPEAT_UNITS, repeatSteps, withRepeatUnit } from './agentScheduleRepeat';

interface AgentScheduleRepeatControlsProps {
  settings: RepeatSettings;
  onChange: (settings: RepeatSettings) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy: string;
}

const SELECT_CLASSES = 'rounded-md border bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:bg-slate-50 disabled:text-slate-500';
const pad = (value: number) => String(value).padStart(2, '0');
// Two selects rather than a time input, which a 12-hour locale shows as "09:00 AM" beside 24-hour UTC times.
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES = Array.from({ length: 60 }, (_, minute) => minute);

/** Monday first, as a week is read; values are cron day numbers. */
const WEEK = [
  { day: 1, short: 'Mon', name: 'Monday' },
  { day: 2, short: 'Tue', name: 'Tuesday' },
  { day: 3, short: 'Wed', name: 'Wednesday' },
  { day: 4, short: 'Thu', name: 'Thursday' },
  { day: 5, short: 'Fri', name: 'Friday' },
  { day: 6, short: 'Sat', name: 'Saturday' },
  { day: 0, short: 'Sun', name: 'Sunday' },
];

const unitLabel = (unit: RepeatUnit, settings: RepeatSettings): string => {
  if (unit === 'days') return 'day';
  if (unit === 'weeks') return 'week';
  const one = settings.unit === unit && settings.every === 1;
  return unit === 'hours' ? (one ? 'hour' : 'hours') : 'minutes';
};

/** `Every [N] [minutes | hours | day | week] at [HH]:[MM] UTC`, plus the days of a weekly schedule. */
export const AgentScheduleRepeatControls: React.FC<AgentScheduleRepeatControlsProps> = ({ settings, onChange, disabled, invalid, describedBy }) => {
  const steps = repeatSteps(settings.unit);
  const timed = settings.unit === 'days' || settings.unit === 'weeks';
  const border = invalid ? 'border-red-400' : 'border-slate-300';

  const toggleDay = (day: number, checked: boolean) => {
    const weekdays = checked ? [...settings.weekdays, day] : settings.weekdays.filter(value => value !== day);
    if (weekdays.length) onChange({ ...settings, weekdays });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
        <label htmlFor={steps.length > 1 ? 'agent-schedule-every' : 'agent-schedule'}>Every</label>
        {steps.length > 1 && (
          <select
            id="agent-schedule-every"
            value={settings.every}
            disabled={disabled}
            onChange={event => onChange({ ...settings, every: Number(event.target.value) })}
            className={`${SELECT_CLASSES} ${border}`}
          >
            {steps.map(step => <option key={step} value={step}>{step}</option>)}
          </select>
        )}
        <select
          id="agent-schedule"
          aria-label={steps.length > 1 ? 'Unit' : undefined}
          value={settings.unit}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={event => onChange(withRepeatUnit(settings, event.target.value as RepeatUnit))}
          className={`${SELECT_CLASSES} ${border}`}
        >
          {REPEAT_UNITS.map(unit => <option key={unit} value={unit}>{unitLabel(unit, settings)}</option>)}
        </select>
        {timed && (
          <>
            <span aria-hidden="true">at</span>
            <span className="inline-flex items-center gap-1">
              <select
                id="agent-schedule-time"
                aria-label="Hour (UTC)"
                value={settings.hour}
                disabled={disabled}
                onChange={event => onChange({ ...settings, hour: Number(event.target.value) })}
                className={`${SELECT_CLASSES} ${border} font-mono`}
              >
                {HOURS.map(hour => <option key={hour} value={hour}>{pad(hour)}</option>)}
              </select>
              <span aria-hidden="true">:</span>
              <select
                aria-label="Minute"
                value={settings.minute}
                disabled={disabled}
                onChange={event => onChange({ ...settings, minute: Number(event.target.value) })}
                className={`${SELECT_CLASSES} ${border} font-mono`}
              >
                {MINUTES.map(minute => <option key={minute} value={minute}>{pad(minute)}</option>)}
              </select>
            </span>
            <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-500">UTC</span>
          </>
        )}
      </div>
      {settings.unit === 'weeks' && (
        <fieldset>
          <legend className="sr-only">Days of the week</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEK.map(({ day, short, name }) => {
              const checked = settings.weekdays.includes(day);
              const last = checked && settings.weekdays.length === 1;
              return (
                <label
                  key={day}
                  title={last ? 'Keep at least one day' : name}
                  className={`relative inline-flex cursor-pointer items-center rounded-full border px-2.5 py-0.5 text-xs focus-within:ring-2 focus-within:ring-teal-500 ${checked ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}
                >
                  <input
                    type="checkbox"
                    aria-label={name}
                    checked={checked}
                    disabled={disabled}
                    onChange={event => toggleDay(day, event.target.checked)}
                    className="sr-only"
                  />
                  {short}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
    </div>
  );
};
