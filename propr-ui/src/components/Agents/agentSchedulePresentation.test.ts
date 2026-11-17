import { describe, expect, it } from 'vitest';
import { describeCron, describeSchedule, scheduleSentence, scheduleSummary, scheduleTooltip } from './agentPresentation';
import { runTriggerSummary } from './agentRunPresentation';

describe('schedules in words', () => {
  it.each([
    ['0 * * * *', 'Hourly', 'every hour'],
    ['@hourly', 'Hourly', 'every hour'],
    ['30 * * * *', 'Hourly at :30', 'every hour at :30'],
    ['*/15 * * * *', 'Every 15 minutes', 'every 15 minutes'],
    ['0 */3 * * *', 'Every 3 hours', 'every 3 hours'],
    ['15 */6 * * *', 'Every 6 hours at :15', 'every 6 hours at :15'],
    ['0 9 * * *', 'Daily 09:00 UTC', 'every day 09:00 UTC'],
    ['@daily', 'Daily 00:00 UTC', 'every day 00:00 UTC'],
    ['0 7 * * 1-5', 'Weekdays 07:00 UTC', 'weekdays 07:00 UTC'],
    ['0 10 * * 0,6', 'Weekends 10:00 UTC', 'weekends 10:00 UTC'],
    ['0 9 * * 1', 'Weekly Mon 09:00 UTC', 'every Mon 09:00 UTC'],
    ['0 9 * * 7', 'Weekly Sun 09:00 UTC', 'every Sun 09:00 UTC'],
    ['0 9 * * 1,3,5', 'Mon, Wed, Fri 09:00 UTC', 'every Mon, Wed, Fri 09:00 UTC'],
    ['0 9,17 * * *', 'Daily 09:00 and 17:00 UTC', 'every day 09:00 and 17:00 UTC'],
    ['0 6 1 * *', 'Monthly on day 1, 06:00 UTC', 'monthly on day 1, 06:00 UTC'],
  ])('%s reads "%s" in a list and "%s" after Scheduled', (expression, title, phrase) => {
    expect(describeCron(expression)).toBe(title);
    expect(scheduleSentence(expression)).toBe(phrase);
  });

  it('shows an expression that reads as no simple pattern as itself', () => {
    expect(describeSchedule('5-10 9 * 1-6 *')).toBeNull();
    expect(describeCron('5-10 9 * 1-6 *')).toBe('5-10 9 * 1-6 * (UTC)');
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
      .toEqual({ label: 'Scheduled', detail: 'every day 09:00 UTC', tooltip: '0 9 * * * (UTC)' });
  });

  it('keeps the recorded source of other triggers', () => {
    expect(runTriggerSummary({ trigger: 'manual', triggerEvent: null, triggerSource: null })).toEqual({ label: 'Run now', detail: null, tooltip: null });
    expect(runTriggerSummary({ trigger: 'mcp', triggerEvent: null, triggerSource: 'mcp:claude' })).toEqual({ label: 'MCP', detail: 'mcp:claude', tooltip: 'mcp:claude' });
  });
});
