const ACCOUNT_STATUS_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Validate an account-status ISO-8601 instant without normalizing its calendar date. */
export function isAccountStatusTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ACCOUNT_STATUS_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;

  const daysInMonth = month === 2 && isLeapYear(year)
    ? 29
    : DAYS_PER_MONTH[month - 1];
  return day >= 1
    && day <= daysInMonth
    && !Number.isNaN(Date.parse(value));
}
