import { describe, expect, it } from 'vitest';
import { applyPlanIssueDefaults, resolvePlanIssueDefaultSelection } from './planIssueDefaultSelection';

describe('resolvePlanIssueDefaultSelection', () => {
  const agents = [
    {
      id: 'agent-1',
      type: 'claude' as const,
      alias: 'claude-prod',
      enabled: true,
      dockerImage: 'claude',
      configPath: '/tmp/claude.json',
      supportedModels: ['claude-haiku-4-5'],
      defaultModel: 'claude-haiku-4-5'
    },
    {
      id: 'agent-2',
      type: 'codex' as const,
      alias: 'codex-prod',
      enabled: true,
      dockerImage: 'codex',
      configPath: '/tmp/codex.json',
      supportedModels: ['gpt-5.4'],
      defaultModel: 'gpt-5.4'
    }
  ];

  const agentsWithVibe = [
    ...agents,
    {
      id: 'agent-3',
      type: 'vibe' as const,
      alias: 'vibe-prod',
      enabled: true,
      dockerImage: 'propr/agent-vibe:latest',
      configPath: '~/.vibe',
      supportedModels: ['mistral-medium-3.5', 'devstral-2512'],
      defaultModel: 'mistral-medium-3.5'
    }
  ];

  it('prefers default_agent_alias over the first enabled agent', () => {
    expect(resolvePlanIssueDefaultSelection(agents, 'codex-prod')).toEqual({
      agentAlias: 'codex-prod',
      modelName: 'gpt-5.4'
    });
  });

  it('falls back deterministically when the configured default agent is unavailable', () => {
    expect(resolvePlanIssueDefaultSelection(agents, 'missing-agent')).toEqual({
      agentAlias: 'claude-prod',
      modelName: 'claude-haiku-4-5'
    });
  });

  it('selects vibe agent when configured as default', () => {
    expect(resolvePlanIssueDefaultSelection(agentsWithVibe, 'vibe-prod')).toEqual({
      agentAlias: 'vibe-prod',
      modelName: 'mistral-medium-3.5'
    });
  });

  it('falls back to first agent when vibe default is unavailable', () => {
    expect(resolvePlanIssueDefaultSelection(agents, 'vibe-prod')).toEqual({
      agentAlias: 'claude-prod',
      modelName: 'claude-haiku-4-5'
    });
  });
});

describe('applyPlanIssueDefaults', () => {
  it('only applies configured defaults to legacy pending issues with both fields null', () => {
    const issues = applyPlanIssueDefaults([
      {
        id: 1,
        draft_id: 'draft-1',
        repository: 'integry/propr',
        issue_number: 101,
        pr_number: null,
        status: 'pending',
        agent_alias: null,
        model_name: null,
        followup_count: 0,
        task_id: null,
        created_at: '2026-05-07T00:00:00Z',
        updated_at: '2026-05-07T00:00:00Z'
      },
      {
        id: 2,
        draft_id: 'draft-1',
        repository: 'integry/propr',
        issue_number: 102,
        pr_number: null,
        status: 'pending',
        agent_alias: 'claude-prod',
        model_name: 'claude-haiku-4-5',
        followup_count: 0,
        task_id: null,
        created_at: '2026-05-07T00:00:00Z',
        updated_at: '2026-05-07T00:00:00Z'
      },
      {
        id: 3,
        draft_id: 'draft-1',
        repository: 'integry/propr',
        issue_number: 103,
        pr_number: null,
        status: 'pending',
        agent_alias: 'claude-prod',
        model_name: null,
        followup_count: 0,
        task_id: null,
        created_at: '2026-05-07T00:00:00Z',
        updated_at: '2026-05-07T00:00:00Z'
      }
    ], {
      agentAlias: 'codex-prod',
      modelName: 'gpt-5.4'
    });

    expect(issues).toEqual([
      expect.objectContaining({
        issue_number: 101,
        agent_alias: 'codex-prod',
        model_name: 'gpt-5.4'
      }),
      expect.objectContaining({
        issue_number: 102,
        agent_alias: 'claude-prod',
        model_name: 'claude-haiku-4-5'
      }),
      expect.objectContaining({
        issue_number: 103,
        agent_alias: 'claude-prod',
        model_name: null
      })
    ]);
  });
});
