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

  it('lists every reasoning level by its plain name', () => {
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
          pr_review_max_context_tokens: 0, pr_review_context_budget_percent: 100
        }}
        summarizationSettings={{ enabled: true, agent_alias: '' }}
        agents={[]}
        onSettingChange={vi.fn()}
        onReviewPromptChange={vi.fn()}
        onReviewPromptBlur={vi.fn()}
        onReviewContextEnabledChange={vi.fn()}
        onReviewContextBudgetPercentChange={vi.fn()}
        onReviewContextBudgetPercentCommit={vi.fn()}
        onRemoveLegacyReviewCap={vi.fn()}
        onSummarizationModelChange={vi.fn()}
        onSummarizationFallbackModelChange={vi.fn()}
        onDefaultAgentChange={vi.fn()}
      />
    );

    expect(screen.getByText('Fast analysis model')).toBeInTheDocument();
    expect(screen.getByText('Used by /review to gather repository context before the review.')).toBeInTheDocument();
    expect(screen.queryByText('Post-Implementation Analysis Model')).not.toBeInTheDocument();

    const options = within(screen.getByLabelText('Reasoning level'))
      .getAllByRole('option')
      .map(option => option.textContent);

    expect(options).toEqual([
      'Agent default',
      'Low',
      'Medium',
      'High',
      'XHigh',
      'Max',
      'Ultra (Codex only)',
      'Ultracode (Claude only)',
      'Auto (Claude only)'
    ]);
  });

  it('leaves the experimental dashboard summary toggle out of model selection', () => {
    render(<AIModelSelectionSection
      settings={{ analysis_model_fast: '', planner_context_model: '', planner_generation_model: '',
        default_agent_alias: '', model_reasoning_level: '', pr_review_model: '', pr_review_prompt: '',
        pr_review_context_enabled: true, pr_review_context_model: '', pr_review_max_context_tokens: 0,
        pr_review_context_budget_percent: 100 }}
      summarizationSettings={{ enabled: true, agent_alias: '' }} agents={[]}
      onSettingChange={vi.fn()} onReviewPromptChange={vi.fn()} onReviewPromptBlur={vi.fn()}
      onReviewContextEnabledChange={vi.fn()} onReviewContextBudgetPercentChange={vi.fn()}
      onReviewContextBudgetPercentCommit={vi.fn()} onRemoveLegacyReviewCap={vi.fn()}
      onSummarizationModelChange={vi.fn()} onSummarizationFallbackModelChange={vi.fn()}
      onDefaultAgentChange={vi.fn()}
    />);
    expect(screen.queryByRole('checkbox', { name: /Dashboard/ })).not.toBeInTheDocument();
  });

  it('can disable related-code context gathering', () => {
    const onEnabledChange = vi.fn();
    render(
      <AIModelSelectionSection
        settings={{
          analysis_model_fast: '', planner_context_model: '', planner_generation_model: '',
          default_agent_alias: '', model_reasoning_level: '', pr_review_model: '', pr_review_prompt: '',
          pr_review_context_enabled: true, pr_review_context_model: '', pr_review_max_context_tokens: 0, pr_review_context_budget_percent: 100
        }}
        summarizationSettings={{ enabled: true, agent_alias: '' }}
        agents={[]}
        onSettingChange={vi.fn()}
        onReviewPromptChange={vi.fn()}
        onReviewPromptBlur={vi.fn()}
        onReviewContextEnabledChange={onEnabledChange}
        onReviewContextBudgetPercentChange={vi.fn()}
        onReviewContextBudgetPercentCommit={vi.fn()}
        onRemoveLegacyReviewCap={vi.fn()}
        onSummarizationModelChange={vi.fn()}
        onSummarizationFallbackModelChange={vi.fn()}
        onDefaultAgentChange={vi.fn()}
      />
    );
    const checkbox = screen.getByLabelText('Gather related unchanged code');
    const labelColumn = checkbox.parentElement?.querySelector('div');
    expect(labelColumn).toContainElement(screen.getByText('Gather related unchanged code'));
    expect(labelColumn).toContainElement(screen.getByText(/Lets a read-only scout locate/));
    fireEvent.click(checkbox);
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it('offers readable synthetic models and submits their internal values', () => {
    const submittedSettings: Array<{ name: string; value: string }> = [];
    render(
      <AIModelSelectionSection
        settings={{
          analysis_model_fast: '', planner_context_model: '', planner_generation_model: '',
          default_agent_alias: '', model_reasoning_level: '', pr_review_model: '', pr_review_prompt: '',
          pr_review_context_enabled: true, pr_review_context_model: '', pr_review_max_context_tokens: 0, pr_review_context_budget_percent: 100
        }}
        summarizationSettings={{ enabled: true, agent_alias: '' }}
        agents={[]}
        catalogAgents={[{
          id: 'pool-balanced',
          kind: 'synthetic',
          alias: 'balanced',
          enabled: true,
          supportedModels: ['virtual-code']
        }]}
        onSettingChange={event => {
          submittedSettings.push({ name: event.target.name, value: event.target.value });
        }}
        onReviewPromptChange={vi.fn()}
        onReviewPromptBlur={vi.fn()}
        onReviewContextEnabledChange={vi.fn()}
        onReviewContextBudgetPercentChange={vi.fn()}
        onReviewContextBudgetPercentCommit={vi.fn()}
        onRemoveLegacyReviewCap={vi.fn()}
        onSummarizationModelChange={vi.fn()}
        onSummarizationFallbackModelChange={vi.fn()}
        onDefaultAgentChange={vi.fn()}
      />
    );

    for (const label of ['Plan context analysis model', 'Plan generation model', 'Default PR review model', 'Context scout model']) {
      expect(within(screen.getByLabelText(label)).getByRole('option', { name: 'balanced - Virtual Code' }))
        .toHaveValue('balanced:virtual-code');
    }

    fireEvent.change(screen.getByLabelText('Plan generation model'), {
      target: { value: 'balanced:virtual-code' },
    });
    expect(submittedSettings).toEqual([{ name: 'planner_generation_model', value: 'balanced:virtual-code' }]);
  });

  it.each([
    ['a disabled agent', 'gemini-old:virtual-flash', 'gemini-old - Virtual Flash'],
    ['an agent that is no longer configured', 'removed:virtual-pro', 'removed - Virtual Pro'],
  ])('names a saved summarization fallback from %s by its display name, not its raw id', (_case, fallback, label) => {
    render(
      <AIModelSelectionSection
        settings={{
          analysis_model_fast: '', planner_context_model: '', planner_generation_model: '',
          default_agent_alias: '', model_reasoning_level: '', pr_review_model: '', pr_review_prompt: '',
          pr_review_context_enabled: true, pr_review_context_model: '', pr_review_max_context_tokens: 0, pr_review_context_budget_percent: 100
        }}
        summarizationSettings={{ enabled: true, agent_alias: 'balanced:virtual-code', fallback_agent_alias: fallback }}
        agents={[]}
        catalogAgents={[
          { id: 'pool-balanced', kind: 'synthetic', alias: 'balanced', enabled: true, supportedModels: ['virtual-code'] },
          { id: 'pool-old', kind: 'synthetic', alias: 'gemini-old', enabled: false, supportedModels: ['virtual-flash'] },
        ]}
        onSettingChange={vi.fn()} onReviewPromptChange={vi.fn()} onReviewPromptBlur={vi.fn()}
        onReviewContextEnabledChange={vi.fn()} onReviewContextBudgetPercentChange={vi.fn()}
        onReviewContextBudgetPercentCommit={vi.fn()} onRemoveLegacyReviewCap={vi.fn()}
        onSummarizationModelChange={vi.fn()} onSummarizationFallbackModelChange={vi.fn()}
        onDefaultAgentChange={vi.fn()}
      />
    );

    const select = screen.getByLabelText('Summarization fallback model');
    expect(select).toHaveDisplayValue(label);
    expect(within(select).queryByRole('option', { name: new RegExp(fallback) })).not.toBeInTheDocument();
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
