import { describe, expect, it } from 'vitest';
import { buildCreateGoalParams, type GoalFormValues, validateGoalForm } from './goalCreateUtils';

const values = (overrides: Partial<GoalFormValues> = {}): GoalFormValues => ({
  objective: 'a'.repeat(10),
  repository: 'integry/propr',
  agent: 'codex',
  model: 'gpt-5.6-sol',
  maxActiveTasks: 1,
  mergePolicy: 'manual',
  ultrafixEnabled: true,
  ultrafixGoal: '1',
  ultrafixMaxCycles: '20',
  ...overrides,
});

describe('goalCreateUtils shared bounds', () => {
  it('accepts objective/max-active/Ultrafix boundaries exactly', () => {
    expect(validateGoalForm(values())).toEqual({});
    expect(validateGoalForm(values({ objective: 'a'.repeat(4000), maxActiveTasks: 20, ultrafixGoal: '10', ultrafixMaxCycles: '1' }))).toEqual({});
  });

  it('rejects objective and integer values just outside their bounds', () => {
    expect(validateGoalForm(values({ objective: '  123456789  ' })).objective).toMatch(/at least 10.*after trimming/);
    expect(validateGoalForm(values({ objective: 'a'.repeat(4001) })).objective).toMatch(/at most 4000/);
    expect(validateGoalForm(values({ maxActiveTasks: 21 })).maxActiveTasks).toBeDefined();
    expect(validateGoalForm(values({ ultrafixGoal: '0' })).ultrafixGoal).toBeDefined();
    expect(validateGoalForm(values({ ultrafixMaxCycles: '21' })).ultrafixMaxCycles).toBeDefined();
    expect(validateGoalForm(values({ ultrafixGoal: '1.5', ultrafixMaxCycles: '2.5' }))).toMatchObject({
      ultrafixGoal: expect.any(String), ultrafixMaxCycles: expect.any(String),
    });
  });

  it('sends explicit nulls when Ultrafix is disabled', () => {
    expect(buildCreateGoalParams(values({ ultrafixEnabled: false, ultrafixGoal: '', ultrafixMaxCycles: '' }))).toMatchObject({
      ultrafixEnabled: false, ultrafixGoal: null, ultrafixMaxCycles: null,
    });
  });
});
