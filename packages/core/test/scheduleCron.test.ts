import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CronExpressionError, localTimeToInstant, nextCronRun, parseCronExpression, upcomingCronRuns } from '../src/schedules/cron.js';

const next = (expression: string, timeZone: string, after: string) => nextCronRun(expression, timeZone, new Date(after))?.toISOString() ?? null;

test('computes the next run in the schedule time zone', () => {
  assert.equal(next('0 3 * * *', 'UTC', '2026-10-06T02:59:00Z'), '2026-10-06T03:00:00.000Z');
  assert.equal(next('0 3 * * *', 'UTC', '2026-10-06T03:00:00Z'), '2026-10-07T03:00:00.000Z', 'strictly after the reference time');
  // 03:00 in Riga (UTC+3 in October) is 00:00 UTC.
  assert.equal(next('0 3 * * *', 'Europe/Riga', '2026-10-06T12:00:00Z'), '2026-10-07T00:00:00.000Z');
  // Friday 10:30 in Kolkata: the next weekday 09:00 is Monday.
  assert.equal(next('0 9 * * MON-FRI', 'Asia/Kolkata', '2026-10-09T05:00:00Z'), '2026-10-12T03:30:00.000Z');
  assert.equal(next('*/15 * * * *', 'UTC', '2026-01-01T00:07:00Z'), '2026-01-01T00:15:00.000Z');
  assert.equal(next('0 0 29 2 *', 'UTC', '2026-01-01T00:00:00Z'), '2028-02-29T00:00:00.000Z');
  assert.equal(next('@weekly', 'UTC', '2026-10-06T00:00:00Z'), '2026-10-11T00:00:00.000Z');
});

test('a wall time skipped by spring-forward fires once, shifted by the gap', () => {
  // Riga moves from 03:00 EET to 04:00 EEST on 2026-03-29; 03:30 does not exist.
  assert.deepEqual(upcomingCronRuns('30 3 * * *', 'Europe/Riga', new Date('2026-03-27T12:00:00Z'), 3).map(run => run.toISOString()), [
    '2026-03-28T01:30:00.000Z', // 03:30 EET
    '2026-03-29T01:30:00.000Z', // 04:30 EEST: the missing 03:30 moved forward one hour
    '2026-03-30T00:30:00.000Z', // 03:30 EEST
  ]);
  // New York skips 02:00-03:00 on 2026-03-08.
  assert.equal(next('0 2 * * *', 'America/New_York', '2026-03-07T12:00:00Z'), '2026-03-08T07:00:00.000Z');
});

test('a wall time repeated by fall-back fires once, at its first occurrence', () => {
  // Riga repeats 03:00-04:00 on 2026-10-25 (EEST, then EET).
  const runs = upcomingCronRuns('30 3 * * *', 'Europe/Riga', new Date('2026-10-24T12:00:00Z'), 2).map(run => run.toISOString());
  assert.deepEqual(runs, ['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z']);
  // After the first 03:30, the repeated 03:30 is not a second run.
  assert.equal(next('30 3 * * *', 'Europe/Riga', '2026-10-25T00:30:00Z'), '2026-10-26T01:30:00.000Z');
  assert.equal(localTimeToInstant({ year: 2026, month: 10, day: 25, hour: 3, minute: 30 }, 'Europe/Riga'), Date.parse('2026-10-25T00:30:00Z'));
});

test('parses lists, ranges, steps, names and shortcuts, and rejects invalid expressions', () => {
  const cron = parseCronExpression('0,30 9-17/2 1,15 JAN-MAR SUN,7');
  assert.deepEqual(cron.minutes, [0, 30]);
  assert.deepEqual(cron.hours, [9, 11, 13, 15, 17]);
  assert.deepEqual([...cron.months], [1, 2, 3]);
  assert.deepEqual([...cron.daysOfWeek], [0]);
  for (const invalid of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '5-1 * * * *', '*/0 * * * *', 'x * * * *']) {
    assert.throws(() => parseCronExpression(invalid), CronExpressionError, invalid);
  }
  assert.throws(() => nextCronRun('0 3 * * *', 'Mars/Olympus', new Date()), /Unknown time zone/);
  assert.equal(next('0 0 30 2 *', 'UTC', '2026-01-01T00:00:00Z'), null);
});

test('restricted day-of-month and day-of-week match either, as in cron', () => {
  // The 13th, or any Friday, in October 2026 (Thursday 1st).
  const runs = upcomingCronRuns('0 0 13 * FRI', 'UTC', new Date('2026-10-01T00:00:00Z'), 3).map(run => run.toISOString().slice(0, 10));
  assert.deepEqual(runs, ['2026-10-02', '2026-10-09', '2026-10-13']);
});
