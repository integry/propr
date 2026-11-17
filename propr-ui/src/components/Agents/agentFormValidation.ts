import {
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PROMPT_MAX_LENGTH,
  AUTOMATION_SCHEDULE_MAX_LENGTH,
  MIN_AUTOMATION_SCHEDULE_INTERVAL_MINUTES,
  validateAutomationSchedule,
} from '@propr/shared';
import { EVENT_TRIGGER_FILTER_LOST_MESSAGE, eventTriggerFilterLost, type AgentEditorForm } from './agentEditorForm';

/**
 * The form's own checks, worded for the person filling it in and shown under
 * the field they concern. The shared input validator still runs on save and
 * the server checks again; their messages name API fields, so they are only a
 * fallback for anything these checks do not cover.
 */

/** Fields that can be invalid, in the order they appear on the form. */
export const AGENT_FORM_FIELDS = ['name', 'prompt', 'schedule', 'eventTrigger'] as const;
export type AgentFormField = typeof AGENT_FORM_FIELDS[number];
export type AgentFormErrors = Partial<Record<AgentFormField, string>>;

/** The control each field's error belongs to; a submit with errors moves focus to the first. */
export const AGENT_FORM_FIELD_IDS: Record<AgentFormField, string> = {
  name: 'agent-name',
  prompt: 'agent-prompt',
  schedule: 'agent-schedule',
  eventTrigger: 'agent-event-trigger',
};

export const agentFieldErrorId = (field: AgentFormField): string => `${AGENT_FORM_FIELD_IDS[field]}-error`;

export const SCHEDULE_EXAMPLE = '0 9 * * 1-5';
export const SCHEDULE_FIVE_PARTS_MESSAGE = `Enter a schedule with five parts, e.g. ${SCHEDULE_EXAMPLE}.`;
export const EVENT_TRIGGER_NO_REPOSITORIES_MESSAGE = 'Choose at least one repository first.';

const CRON_PART_NAMES: Record<string, string> = {
  minute: 'minute',
  hour: 'hour',
  'day-of-month': 'day of the month',
  month: 'month',
  'day-of-week': 'day of the week',
};

/** A cron parse failure in words: which part is wrong, and what it may be. */
const cronParseMessage = (detail: string): string => {
  if (/must have 5 fields/.test(detail)) return SCHEDULE_FIVE_PARTS_MESSAGE;
  const range = detail.match(/^([a-z-]+) value (\d+) is out of range (\d+)-(\d+)$/);
  if (range) return `The ${CRON_PART_NAMES[range[1]] ?? range[1]} must be from ${range[3]} to ${range[4]}.`;
  const invalid = detail.match(/^Invalid ([a-z-]+) (?:value|field|step|range) "(.*)"$/);
  if (invalid) return `“${invalid[2]}” is not a valid ${CRON_PART_NAMES[invalid[1]] ?? invalid[1]}. Use a number, *, a range or a list, e.g. ${SCHEDULE_EXAMPLE}.`;
  return `Enter a valid schedule, e.g. ${SCHEDULE_EXAMPLE}.`;
};

/** What is wrong with a schedule, in words, or null when it is valid. */
export const scheduleErrorMessage = (expression: string): string | null => {
  const trimmed = expression.trim();
  if (!trimmed) return SCHEDULE_FIVE_PARTS_MESSAGE;
  const error = validateAutomationSchedule(trimmed);
  if (!error) return null;
  if (error === 'schedule must be a cron expression') return SCHEDULE_FIVE_PARTS_MESSAGE;
  if (error.startsWith('schedule must be at most')) return `Keep the schedule under ${AUTOMATION_SCHEDULE_MAX_LENGTH} characters.`;
  if (error.startsWith('schedule is not a valid cron expression: ')) return cronParseMessage(error.slice('schedule is not a valid cron expression: '.length));
  if (error === 'schedule never fires') return 'This schedule never runs. Check the day and month parts.';
  if (error === 'schedule must fire at least once a year') return 'Run at least once a year.';
  if (error.startsWith('schedule must not run more often')) return `Run at most every ${MIN_AUTOMATION_SCHEDULE_INTERVAL_MINUTES} minutes.`;
  return `Enter a valid schedule, e.g. ${SCHEDULE_EXAMPLE}.`;
};

/** Every field error the form has now; empty when it can be saved as far as the form can tell. */
export function validateAgentForm(form: AgentEditorForm): AgentFormErrors {
  const errors: AgentFormErrors = {};
  if (!form.name.trim()) errors.name = 'Enter a name.';
  else if (form.name.length > AUTOMATION_NAME_MAX_LENGTH) errors.name = `Keep the name under ${AUTOMATION_NAME_MAX_LENGTH} characters.`;
  if (!form.prompt.trim()) errors.prompt = 'Enter a prompt.';
  else if (form.prompt.length > AUTOMATION_PROMPT_MAX_LENGTH) errors.prompt = `Keep the prompt under ${AUTOMATION_PROMPT_MAX_LENGTH} characters.`;
  if (form.scheduleEnabled) {
    const schedule = scheduleErrorMessage(form.schedule);
    if (schedule) errors.schedule = schedule;
  }
  if (form.blockedTrigger) {
    if (form.repositories.length === 0) errors.eventTrigger = EVENT_TRIGGER_NO_REPOSITORIES_MESSAGE;
    else if (eventTriggerFilterLost(form)) errors.eventTrigger = EVENT_TRIGGER_FILTER_LOST_MESSAGE;
  }
  return errors;
}

/** The first field, in form order, that has an error. */
export const firstInvalidField = (errors: AgentFormErrors): AgentFormField | null =>
  AGENT_FORM_FIELDS.find(field => errors[field]) ?? null;

/** Scrolls the first invalid field into view and focuses it, so a failed submit shows what to fix. */
export function focusAgentField(field: AgentFormField, root: ParentNode = document): void {
  const element = root.querySelector<HTMLElement>(`#${AGENT_FORM_FIELD_IDS[field]}`);
  // A segmented control is focused through its chosen segment.
  const control = element?.matches('[role="radiogroup"]') ? element.querySelector<HTMLElement>('[aria-checked="true"]') ?? element : element;
  if (!control) return;
  control.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  control.focus({ preventScroll: true });
}
