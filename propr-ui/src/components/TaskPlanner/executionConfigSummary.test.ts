import { describe, expect, it } from 'vitest';
import { getExecutionConfigSummary } from './planIssueRowUtils';

const base = { showAgent: true, globalAgent: 'claude', globalModel: 'claude-opus-5-5', globalIsMulti: false, globalSelectedModels: [] };

describe('getExecutionConfigSummary', () => {
  it('summarizes agent, ultrafix goal and auto-merge in one line', () => {
    expect(getExecutionConfigSummary({ ...base, runUltrafix: true, ultrafixGoal: 8, autoMerge: true }))
      .toBe('Opus 5.5 · Ultrafix (8/10) · Auto-merge');
  });

  it('omits disabled options and the agent for single-task plans', () => {
    expect(getExecutionConfigSummary({ ...base, showAgent: false })).toBe('Defaults');
    expect(getExecutionConfigSummary({ ...base, runUltrafix: true, ultrafixGoal: null })).toBe('Opus 5.5 · Ultrafix');
  });

  it('counts models in multi-model mode', () => {
    expect(getExecutionConfigSummary({
      ...base,
      globalIsMulti: true,
      globalSelectedModels: [{ agentAlias: 'claude', modelName: 'a' }, { agentAlias: 'claude', modelName: 'b' }] as never,
    })).toBe('2 models');
  });
});
