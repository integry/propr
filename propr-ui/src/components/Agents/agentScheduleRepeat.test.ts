import { describe, expect, it } from 'vitest';
import { validateAutomationSchedule } from '@propr/shared';
import { describeCron } from './agentPresentation';
import {
  DEFAULT_REPEAT, REPEAT_HOUR_STEPS, REPEAT_MINUTE_STEPS, type RepeatSettings, cronToRepeat, repeatToCron, withRepeatUnit,
} from './agentScheduleRepeat';

const settings = (change: Partial<RepeatSettings>): RepeatSettings => ({ ...DEFAULT_REPEAT, ...change });

describe('Repeat settings to cron', () => {
  it.each([
    [settings({ unit: 'minutes', every: 15 }), '*/15 * * * *'],
    [settings({ unit: 'minutes', every: 30 }), '*/30 * * * *'],
    [settings({ unit: 'hours', every: 1 }), '0 * * * *'],
    [settings({ unit: 'hours', every: 3 }), '0 */3 * * *'],
    [settings({ unit: 'days', hour: 8, minute: 30 }), '30 8 * * *'],
    [settings({ unit: 'weeks', hour: 9, minute: 0, weekdays: [5, 1, 2, 3, 4] }), '0 9 * * 1-5'],
    [settings({ unit: 'weeks', weekdays: [1, 3, 5] }), '0 9 * * 1,3,5'],
    [settings({ unit: 'weeks', weekdays: [0, 6] }), '0 9 * * 0,6'],
    [settings({ unit: 'weeks', weekdays: [0, 1, 2, 4] }), '0 9 * * 0-2,4'],
    [settings({ unit: 'weeks', weekdays: [0, 1, 2, 3, 4, 5, 6] }), '0 9 * * *'],
  ])('%o → %s', (input, expression) => {
    expect(repeatToCron(input)).toBe(expression);
  });

  it('offers only minute and hour steps that divide the period and that the validator accepts', () => {
    expect(REPEAT_MINUTE_STEPS).toEqual([15, 20, 30]);
    expect(REPEAT_HOUR_STEPS).toEqual([1, 2, 3, 4, 6, 8, 12]);
    for (const every of REPEAT_MINUTE_STEPS) expect(60 % every).toBe(0);
    for (const every of REPEAT_HOUR_STEPS) expect(24 % every).toBe(0);
  });
});

describe('cron to Repeat settings', () => {
  const offered: RepeatSettings[] = [
    ...REPEAT_MINUTE_STEPS.map(every => settings({ unit: 'minutes', every })),
    ...REPEAT_HOUR_STEPS.map(every => settings({ unit: 'hours', every })),
    settings({ unit: 'days', hour: 0, minute: 0 }),
    settings({ unit: 'days', hour: 23, minute: 59 }),
    ...[[1], [0], [6], [1, 2, 3, 4, 5], [0, 6], [1, 3, 5], [0, 1, 2, 4], [2, 3]].map(weekdays => settings({ unit: 'weeks', hour: 7, minute: 5, weekdays })),
  ];

  it.each(offered.map(value => [repeatToCron(value), value] as const))('round-trips %s', (expression, value) => {
    expect(validateAutomationSchedule(expression)).toBeNull();
    expect(cronToRepeat(expression)).toEqual(value);
    expect(repeatToCron(cronToRepeat(expression)!)).toBe(expression);
  });

  it('reads 0 9 * * 1-5 as weekly on Monday to Friday at 09:00', () => {
    expect(cronToRepeat('0 9 * * 1-5')).toEqual(settings({ unit: 'weeks', hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5] }));
  });

  it('ignores extra spaces around and between the parts', () => {
    expect(cronToRepeat('  0  */3 * * * ')).toEqual(settings({ unit: 'hours', every: 3 }));
  });

  it.each([
    '', '0 9 * *', '@daily', '@hourly',
    // Steps that do not divide the period, or that the validator refuses.
    '*/5 * * * *', '*/45 * * * *', '0 */5 * * *', '0 */1 * * *',
    // A minute past each hour, several times a day, a day-of-month step, months.
    '30 * * * *', '15 */6 * * *', '0 9,17 * * *', '0 8 */2 * *', '0 6 1 * *', '0 9 * 1-6 *',
    // Same days, written another way: reading them as Repeat would rewrite them.
    '0 9 * * 1,2,3,4,5', '0 9 * * 7', '0 9 * * 0-6', '0 9 * * 1-2', '00 09 * * *', '0 9 * * MON',
    '5-10 9 * * *', '*/15 9 * * *',
  ])('keeps %j custom', expression => {
    expect(cronToRepeat(expression)).toBeNull();
  });

  it('describes a Repeat schedule in the words of its controls', () => {
    expect(describeCron(repeatToCron(settings({ unit: 'hours', every: 3 })))).toBe('Every 3 hours');
    expect(describeCron(repeatToCron(settings({ unit: 'weeks', weekdays: [1, 2, 3, 4, 5] })))).toBe('Every weekday at 09:00 UTC');
    for (const value of offered) expect(describeCron(repeatToCron(value))).toMatch(/^Every /);
  });
});

describe('changing the unit', () => {
  it('keeps an interval that still applies and otherwise takes the first', () => {
    expect(withRepeatUnit(settings({ unit: 'hours', every: 2 }), 'minutes').every).toBe(15);
    expect(withRepeatUnit(settings({ unit: 'minutes', every: 20 }), 'hours').every).toBe(1);
    expect(withRepeatUnit(settings({ unit: 'hours', every: 12 }), 'days').every).toBe(1);
    expect(withRepeatUnit(settings({ unit: 'days', hour: 6, minute: 15 }), 'weeks')).toMatchObject({ unit: 'weeks', hour: 6, minute: 15 });
  });
});
