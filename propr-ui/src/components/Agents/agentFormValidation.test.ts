import { describe, expect, it } from 'vitest';
import { emptyAgentForm, effectiveCapabilities, formToInput, mergeAvailableFor, type AgentEditorForm } from './agentEditorForm';
import {
  EVENT_TRIGGER_NO_REPOSITORIES_MESSAGE,
  SCHEDULE_FIVE_PARTS_MESSAGE,
  firstInvalidField,
  scheduleErrorMessage,
  validateAgentForm,
} from './agentFormValidation';

const form = (patch: Partial<AgentEditorForm> = {}): AgentEditorForm => ({ ...emptyAgentForm(), name: 'Nightly triage', prompt: 'Summarize', ...patch });

describe('automation form validation', () => {
  it('accepts a complete form', () => {
    expect(validateAgentForm(form())).toEqual({});
    expect(firstInvalidField({})).toBeNull();
  });

  it('asks for a name and a prompt in words, not field keys', () => {
    const errors = validateAgentForm(form({ name: '  ', prompt: '' }));
    expect(errors).toEqual({ name: 'Enter a name.', prompt: 'Enter a prompt.' });
    expect(firstInvalidField(errors)).toBe('name');
  });

  it('orders errors as the fields appear on the form', () => {
    const errors = validateAgentForm(form({ prompt: '', scheduleEnabled: true, schedule: '' }));
    expect(firstInvalidField(errors)).toBe('prompt');
    expect(errors.schedule).toBe(SCHEDULE_FIVE_PARTS_MESSAGE);
  });

  it('checks the schedule only while it is on', () => {
    expect(validateAgentForm(form({ scheduleEnabled: false, schedule: 'nonsense' }))).toEqual({});
    expect(validateAgentForm(form({ scheduleEnabled: true, schedule: '0 9 * * 1-5' }))).toEqual({});
  });

  it('asks for a repository before an event trigger can be saved', () => {
    expect(validateAgentForm(form({ blockedTrigger: true }))).toEqual({ eventTrigger: EVENT_TRIGGER_NO_REPOSITORIES_MESSAGE });
    expect(EVENT_TRIGGER_NO_REPOSITORIES_MESSAGE).toBe('Choose at least one repository first.');
    expect(validateAgentForm(form({ blockedTrigger: true, repositories: ['acme/app'] }))).toEqual({});
  });

  it('refuses a trigger filter whose repositories were all removed', () => {
    const errors = validateAgentForm(form({ blockedTrigger: true, repositories: ['acme/api'], blockedTriggerRepositories: ['acme/app'] }));
    expect(errors.eventTrigger).toMatch(/no longer in this automation/);
  });
});

describe('schedule error wording', () => {
  it.each([
    ['', SCHEDULE_FIVE_PARTS_MESSAGE],
    ['0 9 * *', 'Enter a schedule with five parts, e.g. 0 9 * * 1-5.'],
    ['0 9 * * * *', SCHEDULE_FIVE_PARTS_MESSAGE],
    ['*/5 * * * *', 'Run at most every 15 minutes.'],
    ['* * * * *', 'Run at most every 15 minutes.'],
    ['61 * * * *', 'The minute must be from 0 to 59.'],
    ['0 25 * * *', 'The hour must be from 0 to 23.'],
    ['0 9 * * mon', '“mon” is not a valid day of the week. Use a number, *, a range or a list, e.g. 0 9 * * 1-5.'],
    ['@sometimes', 'Enter a valid schedule, e.g. 0 9 * * 1-5.'],
    ['0 0 31 2 *', 'This schedule never runs. Check the day and month parts.'],
  ])('%j reads "%s"', (expression, message) => {
    expect(scheduleErrorMessage(expression)).toBe(message);
  });

  it('accepts valid schedules', () => {
    for (const expression of ['0 9 * * 1-5', '*/15 * * * *', '0 */3 * * *', '@daily']) expect(scheduleErrorMessage(expression)).toBeNull();
  });

  it('never shows the API wording', () => {
    for (const expression of ['', 'x', '0 9 * *', '*/5 * * * *', '61 * * * *']) {
      expect(scheduleErrorMessage(expression)).not.toMatch(/schedule must|cron expression|fields:/);
    }
  });
});

describe('the Report only rule for merging', () => {
  it('allows merging only with an action step', () => {
    expect(mergeAvailableFor('dry_run')).toBe(false);
    expect(mergeAvailableFor('preview')).toBe(true);
    expect(mergeAvailableFor('auto')).toBe(true);
  });

  it('drops merge from what a Report only automation saves, and keeps it otherwise', () => {
    const capabilities = ['repository_read', 'propr_mcp', 'merge'] as const;
    expect(effectiveCapabilities(capabilities, 'dry_run')).toEqual(['repository_read', 'propr_mcp']);
    expect(effectiveCapabilities(capabilities, 'auto')).toEqual(capabilities);
    expect(formToInput(form({ capabilities: [...capabilities], autonomy: 'dry_run' })).capabilities).toEqual(['repository_read', 'propr_mcp']);
    expect(formToInput(form({ capabilities: [...capabilities], autonomy: 'preview' })).capabilities).toEqual([...capabilities]);
  });
});
