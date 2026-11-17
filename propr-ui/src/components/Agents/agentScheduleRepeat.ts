import { MIN_AUTOMATION_SCHEDULE_INTERVAL_MINUTES } from '@propr/shared';

/**
 * The editor's "Repeat" schedule, built from plain controls, and the 5-field
 * UTC cron expression it stands for. Only rhythms a cron expression repeats
 * exactly are offered: a minute step must divide the hour and an hour step the
 * day (`*\/7` hours would run at 21:00 and then again at midnight), and a day
 * step is not offered at all since day-of-month steps restart every month.
 */
export type RepeatUnit = 'minutes' | 'hours' | 'days' | 'weeks';

export interface RepeatSettings {
  unit: RepeatUnit;
  /** Interval for minutes and hours; days and weeks always repeat every one. */
  every: number;
  /** Time of day (UTC) for days and weeks. */
  hour: number;
  minute: number;
  /** 0 (Sunday) to 6 (Saturday), for weeks; at least one. */
  weekdays: number[];
}

/** Minute steps that divide the hour and that the schedule minimum allows. */
export const REPEAT_MINUTE_STEPS: readonly number[] = [5, 10, 15, 20, 30].filter(step => step >= MIN_AUTOMATION_SCHEDULE_INTERVAL_MINUTES);
/** Hour steps that divide the day. */
export const REPEAT_HOUR_STEPS: readonly number[] = [1, 2, 3, 4, 6, 8, 12];

export const REPEAT_UNITS: readonly RepeatUnit[] = ['minutes', 'hours', 'days', 'weeks'];

/** What turning a schedule on starts from: every day at 09:00 UTC. */
export const DEFAULT_REPEAT: RepeatSettings = { unit: 'days', every: 1, hour: 9, minute: 0, weekdays: [1] };

/** The intervals offered for a unit; days and weeks have only one. */
export const repeatSteps = (unit: RepeatUnit): readonly number[] =>
  unit === 'minutes' ? REPEAT_MINUTE_STEPS : unit === 'hours' ? REPEAT_HOUR_STEPS : [1];

/** `1,2,3,4,5` → `1-5`; runs of three or more days become a range. */
const weekdayField = (weekdays: readonly number[]): string => {
  const days = [...new Set(weekdays)].sort((left, right) => left - right);
  const parts: string[] = [];
  for (let index = 0; index < days.length;) {
    let end = index;
    while (end + 1 < days.length && days[end + 1] === days[end] + 1) end += 1;
    if (end - index >= 2) parts.push(`${days[index]}-${days[end]}`);
    else for (let day = index; day <= end; day += 1) parts.push(String(days[day]));
    index = end + 1;
  }
  return parts.join(',');
};

/** The cron expression for Repeat settings. */
export const repeatToCron = (settings: RepeatSettings): string => {
  switch (settings.unit) {
    case 'minutes':
      return `*/${settings.every} * * * *`;
    case 'hours':
      return settings.every === 1 ? '0 * * * *' : `0 */${settings.every} * * *`;
    case 'days':
      return `${settings.minute} ${settings.hour} * * *`;
    case 'weeks': {
      const days = new Set(settings.weekdays);
      return `${settings.minute} ${settings.hour} * * ${days.size === 7 ? '*' : weekdayField([...days])}`;
    }
  }
};

const NUMBER = /^\d{1,2}$/;
const STEP = /^\*\/(\d{1,2})$/;

/** Day numbers of a plain list or range of 0-6; null for anything else. */
const weekdaysOf = (field: string): number[] | null => {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = part.match(/^(\d)(?:-(\d))?$/);
    if (!range) return null;
    const from = +range[1];
    const to = range[2] === undefined ? from : +range[2];
    if (to > 6 || to < from) return null;
    for (let day = from; day <= to; day += 1) days.add(day);
  }
  return [...days].sort((left, right) => left - right);
};

const candidate = (fields: string[]): RepeatSettings | null => {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*') return null;
  const minuteStep = minute.match(STEP);
  if (minuteStep && hour === '*' && dayOfWeek === '*') {
    const every = +minuteStep[1];
    return REPEAT_MINUTE_STEPS.includes(every) ? { ...DEFAULT_REPEAT, unit: 'minutes', every } : null;
  }
  if (!NUMBER.test(minute) || +minute > 59) return null;
  const hourStep = hour === '*' ? ['*', '1'] : hour.match(STEP);
  if (hourStep) {
    const every = +hourStep[1];
    return dayOfWeek === '*' && +minute === 0 && REPEAT_HOUR_STEPS.includes(every) ? { ...DEFAULT_REPEAT, unit: 'hours', every } : null;
  }
  if (!NUMBER.test(hour) || +hour > 23) return null;
  const time = { hour: +hour, minute: +minute };
  if (dayOfWeek === '*') return { ...DEFAULT_REPEAT, ...time, unit: 'days', every: 1 };
  const weekdays = weekdaysOf(dayOfWeek);
  return weekdays ? { ...DEFAULT_REPEAT, ...time, unit: 'weeks', every: 1, weekdays } : null;
};

/**
 * The Repeat settings an expression stands for, or null ("custom") when the
 * controls cannot produce it exactly. An expression is only read as Repeat when
 * the controls give back the very same expression, so opening it never
 * rewrites it (`0 9 * * 1,2,3,4,5`, `@daily` or an hourly step of 1 stay custom).
 */
export const cronToRepeat = (expression: string): RepeatSettings | null => {
  const normalized = expression.trim().split(/\s+/).join(' ');
  const fields = normalized.split(' ');
  if (fields.length !== 5) return null;
  const settings = candidate(fields);
  return settings && repeatToCron(settings) === normalized ? settings : null;
};

/** Settings moved to another unit, keeping what still applies. */
export const withRepeatUnit = (settings: RepeatSettings, unit: RepeatUnit): RepeatSettings => {
  const steps = repeatSteps(unit);
  return { ...settings, unit, every: steps.includes(settings.every) ? settings.every : steps[0] };
};
