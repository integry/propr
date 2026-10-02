/**
 * Which days of the activity chart get a date under them, and what it says.
 *
 * A short window labels every bar, so no one has to count bars to find
 * Thursday: the weekday on top and the day beneath, with the month named on
 * the first day and wherever it changes. Past what fits, the
 * labels step at a regular stride counted back from today (every second day,
 * then weekly, then fortnightly), so the gaps are always even and today is
 * always labelled. A long window steps by month, and a very long one by year.
 *
 * The plan is a pure function of the dates and the width each bar's slot gets,
 * so it can be tested without laying out a chart.
 */

export interface ActivityAxisLabel {
  /** The weekday, the day of the month, the month, or the year. */
  primary: string;
  /** The day under a weekday, or the month or year where it changes. */
  secondary?: string;
}

/** Weekday labels name every day, so they stop at a fortnight. */
const WEEKDAY_MAX_DAYS = 14;
/** Room a weekday over its day ("Wed" over "17") needs. */
const WEEKDAY_SLOT_PX = 28;
/** Room a day number needs; a month under one has its neighbours' empty space. */
const DAY_SLOT_PX = 16;
/** Room a month or a year needs. */
const PERIOD_SLOT_PX = 30;
/** Strides that read as a rhythm: every day, every other day, weekly, fortnightly. */
const DAY_STRIDES = [1, 2, 7, 14];
/** Calendar days in an average month and year, for spacing those labels. */
const DAYS_PER_MONTH = 30.4;
const DAYS_PER_YEAR = 365.25;

const dateOf = (key: string): Date => new Date(`${key}T00:00:00Z`);
const format = (key: string, options: Intl.DateTimeFormatOptions): string =>
  dateOf(key).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });

const month = (key: string) => format(key, { month: 'short' });
const year = (key: string) => key.slice(0, 4);

/**
 * The labels for a run of consecutive UTC day keys, keyed by day, when each
 * day's slot is `slotPx` wide. Days missing from the map draw no label.
 */
export function planActivityAxis(dates: string[], slotPx: number): Map<string, ActivityAxisLabel> {
  const labels = new Map<string, ActivityAxisLabel>();
  const count = dates.length;
  if (count === 0 || !(slotPx > 0)) return labels;

  if (count <= WEEKDAY_MAX_DAYS && slotPx >= WEEKDAY_SLOT_PX) {
    let previousMonth: string | null = null;
    for (const key of dates) {
      const current = month(key);
      const day = String(dateOf(key).getUTCDate());
      labels.set(key, { primary: format(key, { weekday: 'short' }), secondary: current !== previousMonth ? `${current} ${day}` : day });
      previousMonth = current;
    }
    return labels;
  }

  const stride = DAY_STRIDES.find(step => step * slotPx >= DAY_SLOT_PX);
  // Past a quarter a stride of days is a fence of numbers; months read better.
  if (stride !== undefined && count <= 92) {
    let previousMonth: string | null = null;
    dates.forEach((key, index) => {
      if ((count - 1 - index) % stride !== 0) return;
      const current = month(key);
      labels.set(key, {
        primary: String(dateOf(key).getUTCDate()),
        ...(current !== previousMonth ? { secondary: current } : {}),
      });
      previousMonth = current;
    });
    return labels;
  }

  if (DAYS_PER_MONTH * slotPx >= PERIOD_SLOT_PX) {
    let previousYear: string | null = null;
    for (const key of dates) {
      if (!key.endsWith('-01')) continue;
      const current = year(key);
      labels.set(key, { primary: month(key), ...(current !== previousYear ? { secondary: current } : {}) });
      previousYear = current;
    }
  } else if (DAYS_PER_YEAR * slotPx >= PERIOD_SLOT_PX) {
    for (const key of dates) {
      if (key.endsWith('-01-01')) labels.set(key, { primary: year(key) });
    }
  }
  return labels;
}
