/**
 * Five-field cron expressions evaluated in an IANA time zone.
 *
 * Fields are minute, hour, day of month, month and day of week, with `*`,
 * lists, ranges, steps, month/day names and the `@hourly`/`@daily`/`@weekly`/
 * `@monthly`/`@yearly` shortcuts. When both day fields are restricted a day
 * matches either one, as in Vixie cron.
 *
 * Daylight saving time: a wall time that does not exist (spring forward) fires
 * at the same distance after the transition, so a daily 02:30 job still runs
 * once that day. A wall time that happens twice (fall back) fires once, at its
 * first occurrence.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Far enough ahead for `0 0 29 2 1` (a leap day that is also a Monday). */
const SEARCH_DAYS = 366 * 30;
/** DST moves a wall time by at most a few hours; candidates outside this cannot win. */
const SHIFT_WINDOW_MINUTES = 180;

const SHORTCUTS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export interface CronExpression {
  source: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

export class CronExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronExpressionError';
  }
}

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  /** Names accepted in place of numbers (JAN, MON), numbered from `nameOffset`. */
  names?: string[];
  nameOffset?: number;
}

const FIELDS = {
  minute: { label: 'minute', min: 0, max: 59 },
  hour: { label: 'hour', min: 0, max: 23 },
  dayOfMonth: { label: 'day-of-month', min: 1, max: 31 },
  month: { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  dayOfWeek: { label: 'day-of-week', min: 0, max: 7, names: DAY_NAMES },
} satisfies Record<string, FieldSpec>;

function parseValue(text: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(text.toUpperCase()) ?? -1;
  if (named >= 0) return named + (spec.nameOffset ?? 0);
  if (!/^\d+$/.test(text)) throw new CronExpressionError(`Invalid ${spec.label} value "${text}"`);
  const value = Number(text);
  if (value < spec.min || value > spec.max) throw new CronExpressionError(`${spec.label} value ${value} is outside ${spec.min}-${spec.max}`);
  return value;
}

function parseRange(range: string, hasStep: boolean, spec: FieldSpec): [number, number] {
  if (range === '*') return [spec.min, spec.max];
  if (!range.includes('-')) {
    const value = parseValue(range, spec);
    // `5/15` means "from 5, every 15".
    return [value, hasStep ? spec.max : value];
  }
  const bounds = range.split('-');
  if (bounds.length !== 2) throw new CronExpressionError(`Invalid ${spec.label} range "${range}"`);
  const [low, high] = bounds.map(bound => parseValue(bound, spec));
  if (low > high) throw new CronExpressionError(`${spec.label} range "${range}" runs backwards`);
  return [low, high];
}

function parseField(text: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const pieces = part.split('/');
    if (!part || pieces.length > 2) throw new CronExpressionError(`Invalid ${spec.label} field "${text}"`);
    const [range, stepText] = pieces;
    const step = stepText === undefined ? 1 : parseValue(stepText, { label: `${spec.label} step`, min: 1, max: spec.max - spec.min + 1 });
    const [low, high] = parseRange(range, stepText !== undefined, spec);
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

export function parseCronExpression(expression: string): CronExpression {
  const source = expression.trim().replace(/\s+/g, ' ');
  const fields = (SHORTCUTS[source.toLowerCase()] ?? source).split(' ');
  if (fields.length !== 5) {
    throw new CronExpressionError('A cron expression needs five fields: minute hour day-of-month month day-of-week');
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const daysOfWeek = new Set([...parseField(dayOfWeek, FIELDS.dayOfWeek)].map(day => day % 7));
  return {
    source,
    minutes: [...parseField(minute, FIELDS.minute)].sort((a, b) => a - b),
    hours: [...parseField(hour, FIELDS.hour)].sort((a, b) => a - b),
    daysOfMonth: parseField(dayOfMonth, FIELDS.dayOfMonth),
    months: parseField(month, FIELDS.month),
    daysOfWeek,
    dayOfMonthRestricted: !dayOfMonth.startsWith('*'),
    dayOfWeekRestricted: !dayOfWeek.startsWith('*'),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The local calendar date and time of an instant in a time zone. */
export function wallClock(instantMs: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

function offsetMs(instantMs: number, timeZone: string): number {
  const wall = wallClock(instantMs, timeZone);
  const wholeSecond = Math.floor(instantMs / 1000) * 1000;
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - wholeSecond;
}

/**
 * The instant a local wall time names. An ambiguous time resolves to its first
 * occurrence; a skipped time moves forward by the size of the gap.
 */
export function localTimeToInstant(local: Omit<WallClock, 'second'>, timeZone: string): number {
  const { year, month, day, hour, minute } = local;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetMs(guess - DAY_MS, timeZone);
  const offsets = new Set([before, offsetMs(guess, timeZone), offsetMs(guess + DAY_MS, timeZone)]);
  const valid = [...offsets].map(offset => guess - offset).filter(instant => {
    const wall = wallClock(instant, timeZone);
    return wall.year === year && wall.month === month && wall.day === day && wall.hour === hour && wall.minute === minute;
  });
  if (valid.length > 0) return Math.min(...valid);
  return guess - before;
}

function dayMatches(cron: CronExpression, dayOfMonth: number, dayOfWeek: number): boolean {
  const byMonthDay = cron.daysOfMonth.has(dayOfMonth);
  const byWeekDay = cron.daysOfWeek.has(dayOfWeek);
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return byMonthDay || byWeekDay;
  if (cron.dayOfMonthRestricted) return byMonthDay;
  if (cron.dayOfWeekRestricted) return byWeekDay;
  return true;
}

/**
 * The earliest run on one local calendar day that is after `afterMs`. Gap
 * shifting can reorder candidates by up to a few hours, so the scan continues
 * a little past the first match.
 */
function earliestRunOnDay(cron: CronExpression, date: { year: number; month: number; day: number }, timeZone: string,
  bounds: { afterMs: number; fromMinuteOfDay: number }): number | null {
  let best: number | null = null;
  let bestMinuteOfDay = 0;
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) {
      const minuteOfDay = hour * 60 + minute;
      if (minuteOfDay < bounds.fromMinuteOfDay) continue;
      if (best !== null && minuteOfDay > bestMinuteOfDay + SHIFT_WINDOW_MINUTES) return best;
      const instant = localTimeToInstant({ ...date, hour, minute }, timeZone);
      if (instant <= bounds.afterMs || (best !== null && instant >= best)) continue;
      if (best === null) bestMinuteOfDay = minuteOfDay;
      best = instant;
    }
  }
  return best;
}

/** The first run strictly after `after`, or null when the expression can never fire. */
export function nextCronRun(expression: string | CronExpression, timeZone: string, after: Date): Date | null {
  if (!isValidTimeZone(timeZone)) throw new CronExpressionError(`Unknown time zone "${timeZone}"`);
  const cron = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const afterMs = after.getTime();
  const start = wallClock(afterMs, timeZone);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let index = 0; index < SEARCH_DAYS; index++) {
    const date = new Date(startDay + index * DAY_MS);
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!cron.months.has(month) || !dayMatches(cron, day, date.getUTCDay())) continue;
    // Earlier wall times on the first day are already past, give or take a DST shift.
    const fromMinuteOfDay = index === 0 ? start.hour * 60 + start.minute - SHIFT_WINDOW_MINUTES : -1;
    const best = earliestRunOnDay(cron, { year, month, day }, timeZone, { afterMs, fromMinuteOfDay });
    if (best !== null) return new Date(best);
  }
  return null;
}

/** The next `count` runs after `after`, in order. */
export function upcomingCronRuns(expression: string, timeZone: string, after: Date, count: number): Date[] {
  const cron = parseCronExpression(expression);
  const runs: Date[] = [];
  let cursor = after;
  while (runs.length < count) {
    const next = nextCronRun(cron, timeZone, cursor);
    if (!next) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}
