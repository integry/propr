import { describe, expect, it } from 'vitest';
import { describeCron, describeSchedule, scheduleSentence, scheduleSummary, scheduleTooltip } from './agentPresentation';
import { runTriggerSummary } from './agentRunPresentation';

describe('schedules in words', () => {
  it.each([
    ['0 * * * *', 'Every hour', 'every hour'],
    ['@hourly', 'Every hour', 'every hour'],
    ['30 * * * *', 'Every hour at :30', 'every hour at :30'],
    ['*/15 * * * *', 'Every 15 minutes', 'every 15 minutes'],
    ['0 */3 * * *', 'Every 3 hours', 'every 3 hours'],
    ['15 */6 * * *', 'Every 6 hours at :15', 'every 6 hours at :15'],
    ['0 9 * * *', 'Every day at 09:00 UTC', 'every day at 09:00 UTC'],
    ['@daily', 'Every day at 00:00 UTC', 'every day at 00:00 UTC'],
    ['0 7 * * 1-5', 'Every weekday at 07:00 UTC', 'every weekday at 07:00 UTC'],
    ['0 10 * * 0,6', 'Every Sat, Sun at 10:00 UTC', 'every Sat, Sun at 10:00 UTC'],
    ['0 9 * * 1', 'Every Mon at 09:00 UTC', 'every Mon at 09:00 UTC'],
    ['0 9 * * 7', 'Every Sun at 09:00 UTC', 'every Sun at 09:00 UTC'],
    ['0 9 * * 1,3,5', 'Every Mon, Wed, Fri at 09:00 UTC', 'every Mon, Wed, Fri at 09:00 UTC'],
    ['0 9,17 * * *', 'Every day at 09:00 and 17:00 UTC', 'every day at 09:00 and 17:00 UTC'],
    ['0 6 1 * *', 'Every month on day 1 at 06:00 UTC', 'every month on day 1 at 06:00 UTC'],
  ])('%s reads "%s" in a list and "%s" after Scheduled', (expression, title, phrase) => {
    expect(describeCron(expression)).toBe(title);
    expect(scheduleSentence(expression)).toBe(phrase);
  });

  it('shows an expression that reads as no simple pattern as itself', () => {
    expect(describeSchedule('5-10 9 * 1-6 *')).toBeNull();
    expect(describeCron('5-10 9 * 1-6 *')).toBe('5-10 9 * 1-6 * (UTC)');
  });

  it.each([
    // 00, 05, 10, 15, 20, then midnight after 4 hours.
    '0 */5 * * *',
    // :00, :22, :44, then :00 after 16 minutes.
    '*/22 * * * *',
    '30 */7 * * *',
    '*/45 * * * *',
  ])('does not call %s an even interval, since its step does not divide the period', expression => {
    expect(describeSchedule(expression)).toBeNull();
    expect(describeCron(expression)).toBe(`${expression} (UTC)`);
    expect(scheduleSentence(expression)).toBe(`${expression} (UTC)`);
  });

  it.each([
    ['*/20 * * * *', 'Every 20 minutes'],
    ['*/30 * * * *', 'Every 30 minutes'],
    ['0 */8 * * *', 'Every 8 hours'],
    ['0 */12 * * *', 'Every 12 hours'],
  ])('reads %s, whose step divides the period, as "%s"', (expression, title) => {
    expect(describeCron(expression)).toBe(title);
  });

  it('puts the cron in the tooltip of a list row', () => {
    const definition = { scheduleCron: '0 */3 * * *', scheduleEnabled: true, nextRunAt: 2 * 3_600_000, enabled: true, eventTriggers: [] };
    expect(scheduleSummary(definition, 0)).toBe('Every 3 hours · next in 2h');
    expect(scheduleTooltip(definition)).toBe('0 */3 * * * (UTC)');
    expect(scheduleTooltip({ scheduleCron: null, scheduleEnabled: false })).toBeNull();
  });
});

describe('what started a run', () => {
  it('names a scheduled run by its schedule, with the cron in the tooltip', () => {
    expect(runTriggerSummary({ trigger: 'schedule', triggerEvent: null, triggerSource: 'schedule:0 9 * * *' }))
      .toEqual({ label: 'Scheduled', detail: 'every day at 09:00 UTC', tooltip: '0 9 * * * (UTC)' });
  });

  it('keeps the recorded source of other triggers', () => {
    expect(runTriggerSummary({ trigger: 'manual', triggerEvent: null, triggerSource: null })).toEqual({ label: 'Run now', detail: null, tooltip: null });
    expect(runTriggerSummary({ trigger: 'mcp', triggerEvent: null, triggerSource: 'mcp:claude' })).toEqual({ label: 'MCP', detail: 'mcp:claude', tooltip: 'mcp:claude' });
  });
});
