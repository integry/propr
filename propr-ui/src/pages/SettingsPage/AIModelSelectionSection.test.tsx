import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AIModelSelectionSection, { buildAiAgentsSettingsHref } from './AIModelSelectionSection';
import {
  activateStoredHostedTunnelFlow,
  HOSTED_TUNNEL_FLOW_ID_KEY,
  resolveApiBaseUrl,
} from '../../config/runtimeConfig';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
};

describe('AIModelSelectionSection', () => {
  beforeEach(() => {
    activateStoredHostedTunnelFlow('app.propr.dev', '', memoryStorage(), 'empty-context');
  });

  it('shows the GitHub override label for every reasoning level', () => {
    render(
      <AIModelSelectionSection
        settings={{
          analysis_model_fast: '',
          planner_context_model: '',
          planner_generation_model: '',
          default_agent_alias: '',
          model_reasoning_level: '',
          pr_review_model: '',
          pr_review_prompt: '',
          pr_review_context_enabled: true,
          pr_review_context_model: '',
          pr_review_max_context_tokens: 0
        }}
        summarizationSettings={{ enabled: true, agent_alias: '' }}
        agents={[]}
        onSettingChange={vi.fn()}
        onReviewPromptChange={vi.fn()}
        onReviewPromptBlur={vi.fn()}
        onReviewContextEnabledChange={vi.fn()}
        onReviewMaxContextTokensChange={vi.fn()}
        onReviewMaxContextTokensBlur={vi.fn()}
        onSummarizationModelChange={vi.fn()}
        onSummarizationFallbackModelChange={vi.fn()}
        onDefaultAgentChange={vi.fn()}
      />
    );

    const options = within(screen.getByLabelText('Reasoning Level'))
      .getAllByRole('option')
      .map(option => option.textContent);

    expect(options).toEqual([
      'Agent default',
      'Low — GitHub: level-low',
      'Medium — GitHub: level-medium',
      'High — GitHub: level-high',
      'XHigh — GitHub: level-xhigh',
      'Max — GitHub: level-max',
      'Ultra (Codex only) — GitHub: level-ultra',
      'Ultracode (Claude only) — GitHub: level-ultracode',
      'Auto (Claude only) — GitHub: level-auto'
    ]);
  });

  it('can disable related-code context gathering', () => {
    const onEnabledChange = vi.fn();
    render(
      <AIModelSelectionSection
        settings={{
          analysis_model_fast: '', planner_context_model: '', planner_generation_model: '',
          default_agent_alias: '', model_reasoning_level: '', pr_review_model: '', pr_review_prompt: '',
          pr_review_context_enabled: true, pr_review_context_model: '', pr_review_max_context_tokens: 0
        }}
        summarizationSettings={{ enabled: true, agent_alias: '' }}
        agents={[]}
        onSettingChange={vi.fn()}
        onReviewPromptChange={vi.fn()}
        onReviewPromptBlur={vi.fn()}
        onReviewContextEnabledChange={onEnabledChange}
        onReviewMaxContextTokensChange={vi.fn()}
        onReviewMaxContextTokensBlur={vi.fn()}
        onSummarizationModelChange={vi.fn()}
        onSummarizationFallbackModelChange={vi.fn()}
        onDefaultAgentChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText('Gather related unchanged code'));
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it('does not put a raw attacker flow on the AI Agents link when no active flow exists', () => {
    expect(buildAiAgentsSettingsHref('app.propr.dev')).toBe('/ai-agents');
  });

  it('puts the validated active hosted flow on the AI Agents link href', () => {
    const storage = memoryStorage();
    resolveApiBaseUrl(
      'app.propr.dev',
      '?tunnel=t-aiagents.propr.dev',
      undefined,
      undefined,
      storage,
      'aiagents-context'
    );
    const flowId = storage.setItem.mock.calls.find(([key]) => key === HOSTED_TUNNEL_FLOW_ID_KEY)?.[1];

    expect(buildAiAgentsSettingsHref('app.propr.dev')).toBe(`/ai-agents?flow=${flowId}`);
    expect(buildAiAgentsSettingsHref('localhost')).toBe('/ai-agents');
  });
});
