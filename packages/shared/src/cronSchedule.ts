/**
 * Dependency-free 5-field cron evaluator shared by the agent scheduler, the
 * API (validation and "next run" previews) and the UI, so every surface
 * computes the same next run time.
 *
 * Supported syntax: `minute hour day-of-month month day-of-week` with `*`,
 * lists (`1,2`), ranges (`1-5`), steps (`*\/15`, `1-30/5`) and the macros
 * `@hourly`, `@daily`, `@weekly` and `@monthly`. Day-of-week accepts 0-7 where
 * both 0 and 7 mean Sunday. When both day-of-month and day-of-week are
 * restricted, a day matches if either field matches (standard cron behavior).
 *
 * v1 limitation: expressions are evaluated in UTC only; timezones are deferred.
 */

export const CRON_MACROS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
} as const;

/** Agent schedules may not fire more often than this (cost guard). */
export const MIN_AGENT_SCHEDULE_INTERVAL_MINUTES = 15;
/** Upper bound for a cron expression string accepted from users. */
export const AGENT_SCHEDULE_MAX_LENGTH = 128;
/** nextCronOccurrence gives up when no match exists within this window. */
export const CRON_SEARCH_LIMIT_DAYS = 366;

export interface ParsedCronExpression {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 (Sunday) to 6 (Saturday); a 7 in the source is normalized to 0. */
  daysOfWeek: ReadonlySet<number>;
  /** False when the day-of-month field is `*` or starts with `*`. */
  daysOfMonthRestricted: boolean;
  /** False when the day-of-week field is `*` or starts with `*`. */
  daysOfWeekRestricted: boolean;
}

interface CronFieldSpec {
  name: string;
  min: number;
  max: number;
}

const CRON_FIELDS: readonly CronFieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function parseCronNumber(value: string, field: CronFieldSpec): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${field.name} value "${value}"`);
  const parsed = Number(value);
  if (parsed < field.min || parsed > field.max) {
    throw new Error(`${field.name} value ${parsed} is out of range ${field.min}-${field.max}`);
  }
  return parsed;
}

function parseCronField(source: string, field: CronFieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of source.split(',')) {
    const [rangePart, stepPart, ...rest] = part.split('/');
    if (rest.length > 0 || !rangePart) throw new Error(`Invalid ${field.name} field "${source}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new Error(`Invalid ${field.name} step "${stepPart}"`);
      step = Number(stepPart);
    }
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = field.min;
      end = field.max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2) throw new Error(`Invalid ${field.name} range "${rangePart}"`);
      start = parseCronNumber(bounds[0], field);
      end = parseCronNumber(bounds[1], field);
      if (start > end) throw new Error(`Invalid ${field.name} range "${rangePart}"`);
    } else {
      start = parseCronNumber(rangePart, field);
      // `5/10` means "from 5 to the end of the range every 10".
      end = stepPart === undefined ? start : field.max;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/** Parse a 5-field cron expression or macro. Throws an Error with a user-facing message. */
export function parseCronExpression(expr: string): ParsedCronExpression {
  if (typeof expr !== 'string') throw new Error('Cron expression must be a string');
  const trimmed = expr.trim();
  const expanded = Object.prototype.hasOwnProperty.call(CRON_MACROS, trimmed.toLowerCase())
    ? CRON_MACROS[trimmed.toLowerCase() as keyof typeof CRON_MACROS]
    : trimmed;
  if (expanded.startsWith('@')) throw new Error(`Unsupported cron macro "${trimmed}"`);
  const parts = expanded.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error('Cron expression must have 5 fields: minute hour day-of-month month day-of-week');

  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = parts.map((part, index) => parseCronField(part, CRON_FIELDS[index]));
  const daysOfWeek = new Set<number>();
  for (const day of rawDaysOfWeek) daysOfWeek.add(day === 7 ? 0 : day);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    daysOfMonthRestricted: !parts[2].startsWith('*'),
    daysOfWeekRestricted: !parts[4].startsWith('*'),
  };
}

function cronDayMatches(cron: ParsedCronExpression, date: Date): boolean {
  if (!cron.months.has(date.getUTCMonth() + 1)) return false;
  const domMatches = cron.daysOfMonth.has(date.getUTCDate());
  const dowMatches = cron.daysOfWeek.has(date.getUTCDay());
  if (cron.daysOfMonthRestricted && cron.daysOfWeekRestricted) return domMatches || dowMatches;
  return domMatches && dowMatches;
}

function toParsed(expr: string | ParsedCronExpression): ParsedCronExpression {
  return typeof expr === 'string' ? parseCronExpression(expr) : expr;
}

/**
 * Return the first occurrence strictly after `after`, evaluated in UTC.
 * Throws when the expression has no occurrence within CRON_SEARCH_LIMIT_DAYS.
 */
export function nextCronOccurrence(expr: string | ParsedCronExpression, after: Date): Date {
  const cron = toParsed(expr);
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) throw new Error('A valid start date is required');
  // Start at the next whole minute after `after`.
  let time = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = time + CRON_SEARCH_LIMIT_DAYS * DAY_MS;

  // Minute stepping, skipping whole days/hours that cannot match.
  while (time <= limit) {
    const date = new Date(time);
    if (!cronDayMatches(cron, date)) {
      time = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
      continue;
    }
    if (!cron.hours.has(date.getUTCHours())) {
      time = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1);
      continue;
    }
    if (cron.minutes.has(date.getUTCMinutes())) return date;
    time += MINUTE_MS;
  }
  throw new Error(`Cron expression has no occurrence within ${CRON_SEARCH_LIMIT_DAYS} days`);
}

/** Smallest gap, in minutes, between two consecutive firings of the expression. */
function minimumCronIntervalMinutes(cron: ParsedCronExpression): number {
  const timesOfDay: number[] = [];
  for (const hour of [...cron.hours].sort((a, b) => a - b)) {
    for (const minute of [...cron.minutes].sort((a, b) => a - b)) timesOfDay.push(hour * 60 + minute);
  }
  let minimum = Infinity;
  for (let i = 1; i < timesOfDay.length; i += 1) minimum = Math.min(minimum, timesOfDay[i] - timesOfDay[i - 1]);
  if (firesOnConsecutiveDays(cron)) {
    minimum = Math.min(minimum, timesOfDay[0] + 24 * 60 - timesOfDay[timesOfDay.length - 1]);
  }
  return minimum;
}

// An 8-year window starting on a leap year covers every month-length and
// weekday alignment that matters for day matching.
const DAY_SCAN_START = Date.UTC(2024, 0, 1);
const DAY_SCAN_DAYS = 8 * 365 + 2;

function matchingDayIndexes(cron: ParsedCronExpression): number[] {
  const indexes: number[] = [];
  for (let day = 0; day < DAY_SCAN_DAYS; day += 1) {
    if (cronDayMatches(cron, new Date(DAY_SCAN_START + day * DAY_MS))) indexes.push(day);
  }
  return indexes;
}

function firesOnConsecutiveDays(cron: ParsedCronExpression): boolean {
  const days = matchingDayIndexes(cron);
  return days.some((day, index) => index > 0 && day - days[index - 1] === 1);
}

/**
 * Validate an agent schedule. Returns a user-facing error, or null when the
 * expression is valid, fires at least once a year and no more often than every
 * MIN_AGENT_SCHEDULE_INTERVAL_MINUTES.
 */
export function validateAgentSchedule(expr: unknown): string | null {
  if (typeof expr !== 'string' || !expr.trim()) return 'schedule must be a cron expression';
  if (expr.length > AGENT_SCHEDULE_MAX_LENGTH) return `schedule must be at most ${AGENT_SCHEDULE_MAX_LENGTH} characters`;
  let cron: ParsedCronExpression;
  try {
    cron = parseCronExpression(expr);
  } catch (error) {
    return `schedule is not a valid cron expression: ${(error as Error).message}`;
  }
  const days = matchingDayIndexes(cron);
  if (days.length === 0) return 'schedule never fires';
  const lastGap = DAY_SCAN_DAYS - days[days.length - 1] + days[0];
  const yearlyGapExceeded = days[0] >= CRON_SEARCH_LIMIT_DAYS
    || lastGap > CRON_SEARCH_LIMIT_DAYS
    || days.some((day, index) => index > 0 && day - days[index - 1] > CRON_SEARCH_LIMIT_DAYS);
  if (yearlyGapExceeded) return 'schedule must fire at least once a year';
  if (minimumCronIntervalMinutes(cron) < MIN_AGENT_SCHEDULE_INTERVAL_MINUTES) {
    return `schedule must not run more often than every ${MIN_AGENT_SCHEDULE_INTERVAL_MINUTES} minutes`;
  }
  return null;
}
