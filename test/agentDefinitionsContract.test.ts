import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_DEFINITION_CONTRACT,
  AUTOMATION_RUN_STATES,
  AUTOMATION_RUN_TRIGGERS,
  AGENT_TYPES_SUPPORTING_PROPR_MCP,
  MAX_AUTOMATION_REPOSITORIES,
  TERMINAL_AUTOMATION_RUN_STATES,
  agentTypeSupportsProprMcp,
  isUnattendedTrigger,
  validateAutomationDefinitionInput,
} from '../packages/shared/src/automationDefinitions.js';
import {
  MIN_AUTOMATION_SCHEDULE_INTERVAL_MINUTES,
  nextCronOccurrence,
  parseCronExpression,
  validateAutomationSchedule,
} from '../packages/shared/src/cronSchedule.js';

const validInput = {
  name: 'Weekly dependency audit',
  prompt: 'Review dependencies and report outdated packages.',
  repositories: ['integry/propr'],
  capabilities: ['repository_read', 'web'],
  autonomy: 'dry_run',
  schedule: '0 9 * * 1',
};

const next = (expr: string, after: string) => nextCronOccurrence(expr, new Date(after)).toISOString();

describe('validateAutomationDefinitionInput', () => {
  test('accepts a valid definition', () => {
    assert.equal(validateAutomationDefinitionInput(validInput), null);
    assert.equal(validateAutomationDefinitionInput({ ...validInput, schedule: null, autonomy: 'auto' }), null);
  });

  test('auto autonomy does not require propr_mcp', () => {
    assert.equal(validateAutomationDefinitionInput({ ...validInput, autonomy: 'auto', capabilities: ['repository_read'] }), null);
  });

  test('rejects an empty name', () => {
    assert.equal(validateAutomationDefinitionInput({ ...validInput, name: '  ' }), 'name is required');
    assert.equal(validateAutomationDefinitionInput({ ...validInput, name: undefined }), 'name is required');
  });

  test('rejects too many repositories', () => {
    const repositories = Array.from({ length: MAX_AUTOMATION_REPOSITORIES + 1 }, (_, i) => `owner/repo${i}`);
    assert.match(validateAutomationDefinitionInput({ ...validInput, repositories }) ?? '', /at most 10/);
    const atLimit = repositories.slice(0, MAX_AUTOMATION_REPOSITORIES);
    assert.equal(validateAutomationDefinitionInput({ ...validInput, repositories: atLimit }), null);
  });

  test('rejects invalid repository format', () => {
    assert.equal(validateAutomationDefinitionInput({ ...validInput, repositories: ['not-a-repo'] }), 'repositories must be in owner/repo format');
    assert.equal(validateAutomationDefinitionInput({ ...validInput, repositories: ['a/b/c'] }), 'repositories must be in owner/repo format');
  });

  test('rejects unknown capability', () => {
    assert.match(validateAutomationDefinitionInput({ ...validInput, capabilities: ['shell'] }) ?? '', /capabilities must be one of/);
  });

  test('rejects unknown autonomy mode', () => {
    assert.match(validateAutomationDefinitionInput({ ...validInput, autonomy: 'yolo' }) ?? '', /autonomy must be one of/);
  });

  test('rejects schedules more frequent than 15 minutes', () => {
    assert.match(validateAutomationDefinitionInput({ ...validInput, schedule: '*/5 * * * *' }) ?? '', /every 15 minutes/);
    assert.match(validateAutomationDefinitionInput({ ...validInput, schedule: '* * * * *' }) ?? '', /every 15 minutes/);
  });

  test('rejects malformed cron', () => {
    for (const schedule of ['0 9 * *', '61 * * * *', 'foo bar baz qux quux', '@yearly', '5-1 * * * *']) {
      assert.match(validateAutomationDefinitionInput({ ...validInput, schedule }) ?? '', /not a valid cron expression/, schedule);
    }
  });

  test('partial validation only checks present fields', () => {
    assert.equal(validateAutomationDefinitionInput({ autonomy: 'preview' }, { partial: true }), null);
    assert.equal(validateAutomationDefinitionInput({ autonomy: 'preview' }), 'name is required');
    assert.equal(validateAutomationDefinitionInput({ name: '' }, { partial: true }), 'name is required');
    assert.match(validateAutomationDefinitionInput({ schedule: '*/1 * * * *' }, { partial: true }) ?? '', /every 15 minutes/);
  });

  test('rejects non-object input and invalid optional fields', () => {
    assert.equal(validateAutomationDefinitionInput(null), 'automation definition must be an object');
    assert.match(validateAutomationDefinitionInput({ ...validInput, previousReportCount: 99 }) ?? '', /previousReportCount/);
    assert.match(validateAutomationDefinitionInput({ ...validInput, enabled: 'yes' }) ?? '', /enabled/);
    assert.match(validateAutomationDefinitionInput({ ...validInput, capabilities: ['web', 'web'] }) ?? '', /duplicates/);
  });
});

describe('agent contract vocabulary', () => {
  test('only manual triggers are attended', () => {
    assert.equal(isUnattendedTrigger('manual'), false);
    for (const trigger of AUTOMATION_RUN_TRIGGERS.filter((t) => t !== 'manual')) assert.equal(isUnattendedTrigger(trigger), true, trigger);
  });

  test('terminal states are a subset of run states', () => {
    for (const state of TERMINAL_AUTOMATION_RUN_STATES) assert.ok((AUTOMATION_RUN_STATES as readonly string[]).includes(state));
    assert.ok(!(TERMINAL_AUTOMATION_RUN_STATES as readonly string[]).includes('awaiting_approval'));
  });

  test('propr_mcp support and contract discovery', () => {
    assert.deepEqual([...AGENT_TYPES_SUPPORTING_PROPR_MCP], ['claude', 'codex']);
    assert.equal(agentTypeSupportsProprMcp('claude'), true);
    assert.equal(agentTypeSupportsProprMcp('vibe'), false);
    assert.equal(AUTOMATION_DEFINITION_CONTRACT.schedule.minIntervalMinutes, MIN_AUTOMATION_SCHEDULE_INTERVAL_MINUTES);
    assert.equal(AUTOMATION_DEFINITION_CONTRACT.schedule.timezone, 'UTC');
  });
});

describe('cron evaluation', () => {
  test('steps', () => {
    assert.equal(next('*/15 * * * *', '2026-10-06T10:07:00Z'), '2026-10-06T10:15:00.000Z');
    assert.equal(next('*/15 * * * *', '2026-10-06T10:15:00Z'), '2026-10-06T10:30:00.000Z');
    assert.equal(next('1-30/5 * * * *', '2026-10-06T10:27:00Z'), '2026-10-06T11:01:00.000Z');
  });

  test('macros', () => {
    assert.equal(next('@daily', '2026-10-06T10:00:00Z'), '2026-10-07T00:00:00.000Z');
    assert.equal(next('@hourly', '2026-10-06T10:00:30Z'), '2026-10-06T11:00:00.000Z');
    assert.equal(next('@weekly', '2026-10-06T10:00:00Z'), '2026-10-11T00:00:00.000Z');
    assert.equal(next('@monthly', '2026-10-06T10:00:00Z'), '2026-11-01T00:00:00.000Z');
  });

  test('weekday ranges skip weekends', () => {
    // 2026-10-09 is a Friday.
    assert.equal(next('0 9 * * 1-5', '2026-10-09T09:00:00Z'), '2026-10-12T09:00:00.000Z');
    assert.equal(next('0 9 * * 1-5', '2026-10-06T08:00:00Z'), '2026-10-06T09:00:00.000Z');
  });

  test('lists, Sunday as 7 and day-of-month/day-of-week OR semantics', () => {
    assert.equal(next('0 8,20 * * *', '2026-10-06T08:00:00Z'), '2026-10-06T20:00:00.000Z');
    assert.equal(next('0 0 * * 7', '2026-10-06T00:00:00Z'), '2026-10-11T00:00:00.000Z');
    // 15th of the month OR any Monday: Monday 2026-10-12 comes first.
    assert.equal(next('0 0 15 * 1', '2026-10-06T00:00:00Z'), '2026-10-12T00:00:00.000Z');
    assert.equal(next('0 0 1 1 *', '2026-10-06T00:00:00Z'), '2027-01-01T00:00:00.000Z');
  });

  test('throws when no occurrence exists', () => {
    assert.throws(() => next('0 0 31 2 *', '2026-10-06T00:00:00Z'), /no occurrence/);
    assert.throws(() => parseCronExpression('0 0 * * 8'), /out of range/);
  });
});

describe('validateAutomationSchedule', () => {
  test('enforces the minimum interval', () => {
    assert.equal(validateAutomationSchedule('*/15 * * * *'), null);
    assert.equal(validateAutomationSchedule('@hourly'), null);
    assert.match(validateAutomationSchedule('*/10 * * * *') ?? '', /every 15 minutes/);
    assert.match(validateAutomationSchedule('0,10 * * * *') ?? '', /every 15 minutes/);
    // 23:55 to 00:05 the next day is only 10 minutes apart.
    assert.match(validateAutomationSchedule('5,55 0,23 * * *') ?? '', /every 15 minutes/);
    assert.equal(validateAutomationSchedule('5,55 0,23 * * 1'), null);
    // Feb 29 and Mar 1 fall on Friday and Saturday only in some leap years
    // (e.g. 2036), where 23:55 to 00:05 is only 10 minutes apart.
    assert.match(validateAutomationSchedule('5,55 0,23 */28 * 5,6') ?? '', /every 15 minutes/);
    assert.equal(nextCronOccurrence('5,55 0,23 */28 * 5,6', new Date('2036-02-29T23:55:00Z')).toISOString(), '2036-03-01T00:05:00.000Z');
    assert.match(validateAutomationSchedule('5,55 0,23 1,29 2,3 *') ?? '', /every 15 minutes/);
    assert.equal(validateAutomationSchedule('5,55 0,23 1,15 * *'), null);
  });

  test('rejects schedules that never fire or fire less than yearly', () => {
    assert.equal(validateAutomationSchedule('0 0 31 2 *'), 'schedule never fires');
    assert.equal(validateAutomationSchedule('0 0 29 2 *'), 'schedule must fire at least once a year');
    assert.equal(validateAutomationSchedule(''), 'schedule must be a cron expression');
  });
});


test('deprecated shared exports alias the automation contract while coding-agent names stay unchanged', async () => {
  const legacy = await import('../packages/shared/src/agentDefinitions.js');
  const canonical = await import('../packages/shared/src/automationDefinitions.js');
  assert.equal(legacy.AGENT_DEFINITION_CONTRACT, canonical.AUTOMATION_DEFINITION_CONTRACT);
  assert.equal(legacy.validateAgentDefinitionInput, canonical.validateAutomationDefinitionInput);
  assert.equal(legacy.AGENT_RUN_STATES, canonical.AUTOMATION_RUN_STATES);
  assert.deepEqual(canonical.AUTOMATION_DEFINITION_CONTRACT.proprMcpAgentTypes, ['claude', 'codex']);
  assert.equal(canonical.validateAutomationDefinitionInput({ name: 'Scan', prompt: 'Report', agentId: 'codex' }), null);
});
