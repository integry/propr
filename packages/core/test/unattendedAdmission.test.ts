import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '../src/db/connection.js';
import { decideUnattendedAdmission, isInsideUnattendedWindow, parseUnattendedWindow } from '../src/schedules/unattendedAdmission.js';

after(closeConnection);

const settings = (window = '', maxConcurrent = 1) => ({ maxConcurrent, window, windowError: null });

test('parses windows, including overnight windows and an empty value', () => {
  assert.deepEqual(parseUnattendedWindow('02:00-07:00@Europe/Riga'), { ok: true, window: { startMinute: 120, endMinute: 420, timeZone: 'Europe/Riga' } });
  assert.deepEqual(parseUnattendedWindow(' 22:30 - 06:00 @ UTC '), { ok: true, window: { startMinute: 1350, endMinute: 360, timeZone: 'UTC' } });
  assert.deepEqual(parseUnattendedWindow(''), { ok: true, window: null });
  assert.deepEqual(parseUnattendedWindow(null), { ok: true, window: null });
  for (const malformed of ['02:00-07:00', '2am-7am@UTC', '02:00-07:00@Nowhere/City', '25:00-07:00@UTC', '02:61-07:00@UTC', '02:00-02:00@UTC', 42]) {
    assert.equal(parseUnattendedWindow(malformed).ok, false, String(malformed));
  }
});

test('the window is evaluated in its own time zone', () => {
  const parsed = parseUnattendedWindow('02:00-07:00@Europe/Riga');
  assert.ok(parsed.ok && parsed.window);
  // 23:30 UTC on Oct 6 is 02:30 in Riga (UTC+3).
  assert.equal(isInsideUnattendedWindow(parsed.window, new Date('2026-10-06T23:30:00Z')), true);
  assert.equal(isInsideUnattendedWindow(parsed.window, new Date('2026-10-06T04:00:00Z')), false, '07:00 is the exclusive end');
  const overnight = parseUnattendedWindow('22:00-06:00@UTC');
  assert.ok(overnight.ok && overnight.window);
  assert.equal(isInsideUnattendedWindow(overnight.window, new Date('2026-10-06T23:00:00Z')), true);
  assert.equal(isInsideUnattendedWindow(overnight.window, new Date('2026-10-06T05:59:00Z')), true);
  assert.equal(isInsideUnattendedWindow(overnight.window, new Date('2026-10-06T12:00:00Z')), false);
});

test('admission honours the concurrency cap and the window', () => {
  const night = new Date('2026-10-06T23:30:00Z');
  const day = new Date('2026-10-06T12:00:00Z');
  assert.deepEqual(decideUnattendedAdmission(settings(), 0, day), { admitted: true });
  assert.equal(decideUnattendedAdmission(settings('', 1), 1, day).admitted, false);
  assert.equal(decideUnattendedAdmission(settings('', 2), 1, day).admitted, true);
  assert.equal(decideUnattendedAdmission(settings('', 0), 0, day).admitted, false, 'a cap of 0 stops unattended work');
  const window = '02:00-07:00@Europe/Riga';
  assert.deepEqual(decideUnattendedAdmission(settings(window), 0, night), { admitted: true });
  const outside = decideUnattendedAdmission(settings(window), 0, day);
  assert.equal(outside.admitted, false);
  assert.equal(!outside.admitted && outside.reason, 'outside_window');
});

test('a malformed window blocks unattended work instead of allowing it', () => {
  const decision = decideUnattendedAdmission(settings('02:00-07:00@Not/AZone', 5), 0, new Date('2026-10-06T23:30:00Z'));
  assert.equal(decision.admitted, false);
  assert.equal(!decision.admitted && decision.reason, 'malformed_window');
  assert.match(!decision.admitted ? decision.message : '', /malformed/);
});
