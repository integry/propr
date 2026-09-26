import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReviewContextSettings from './ReviewContextSettings';
import { parseLoadedData } from './parseLoadedData';
import type { ReviewBudgetPreviewAgent } from './reviewContextBudgetPreview';

const claudeAgent: ReviewBudgetPreviewAgent = {
  alias: 'claude', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5',
};
const codexAgent: ReviewBudgetPreviewAgent = {
  alias: 'codex', type: 'codex', enabled: true, supportedModels: ['gpt-6-astra'], defaultModel: 'gpt-6-astra',
};

function renderSettings(overrides: Partial<{
  pr_review_model: string;
  pr_review_max_context_tokens: number;
  pr_review_context_budget_percent: number;
}> = {}, catalogAgents = [] as Array<{ alias: string; kind: 'direct' | 'synthetic'; enabled: boolean; supportedModels: string[] }>) {
  const handlers = {
    onSettingChange: vi.fn(),
    onEnabledChange: vi.fn(),
    onBudgetPercentChange: vi.fn(),
    onBudgetPercentCommit: vi.fn(),
    onRemoveLegacyCap: vi.fn(),
  };
  const view = render(
    <ReviewContextSettings
      settings={{
        pr_review_model: 'claude:claude-opus-5-5',
        default_agent_alias: 'claude',
        pr_review_context_enabled: true,
        pr_review_context_model: '',
        pr_review_max_context_tokens: 0,
        pr_review_context_budget_percent: 100,
        ...overrides,
      }}
      agents={[claudeAgent, codexAgent]}
      budgetAgents={[claudeAgent, codexAgent]}
      catalogAgents={catalogAgents}
      {...handlers}
    />,
  );
  return { ...view, handlers };
}

describe('ReviewContextSettings', () => {
  it('replaces the numeric token field with a labelled 10% step slider', () => {
    renderSettings();

    const slider = screen.getByRole('slider', { name: 'Review context budget' });
    expect(slider).toHaveAttribute('min', '10');
    expect(slider).toHaveAttribute('max', '100');
    expect(slider).toHaveAttribute('step', '10');
    expect(slider).toHaveValue('100');
    expect(slider).toHaveAttribute('aria-valuetext', '100% of the safe input allowance');
    expect(screen.getByText('100%').tagName).toBe('OUTPUT');
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByText('Maximum Review Context')).toBeNull();
    expect(screen.getByText(/A lower percentage reduces review context and can produce/)).toBeInTheDocument();
  });

  it('shows the effective allowance of the configured reviewer', () => {
    renderSettings({ pr_review_context_budget_percent: 50 });

    const allowance = screen.getByTestId('review-context-budget-allowance');
    expect(allowance).toHaveTextContent('≈ 474K input tokens for claude - Claude Opus 5.5');
    expect(allowance).toHaveTextContent('50% of 948K safe; verified runtime window');
  });

  it('shows per-reviewer differences for configured agents', () => {
    renderSettings();

    const list = screen.getByRole('list', { name: 'Estimated input allowance by reviewer model' });
    const rows = within(list).getAllByRole('listitem').map(row => row.textContent);
    expect(rows).toEqual(['claude - Claude Opus 5.5≈ 948K', 'codex - GPT-6 Astra≈ 201K']);
  });

  it('reports an automatic state for a routed reviewer instead of inventing precision', () => {
    renderSettings({ pr_review_model: 'pool:balanced' }, [{ alias: 'pool', kind: 'synthetic', enabled: true, supportedModels: ['balanced'] }]);

    expect(screen.getByTestId('review-context-budget-allowance')).toHaveTextContent('Automatic — allowance is resolved per reviewer when a review runs');
    expect(screen.getByText(/each reviewer uses its own budget/)).toBeInTheDocument();
  });

  it('saves once per completed keyboard or pointer interaction', () => {
    const { handlers } = renderSettings();
    const slider = screen.getByRole('slider', { name: 'Review context budget' });

    fireEvent.blur(slider);
    expect(handlers.onBudgetPercentCommit).not.toHaveBeenCalled();

    fireEvent.change(slider, { target: { value: '90' } });
    expect(handlers.onBudgetPercentChange).toHaveBeenCalledWith(90);
    fireEvent.keyUp(slider, { key: 'ArrowLeft' });
    fireEvent.blur(slider);
    expect(handlers.onBudgetPercentCommit).toHaveBeenCalledTimes(1);
    expect(handlers.onBudgetPercentCommit).toHaveBeenCalledWith(90);

    fireEvent.change(slider, { target: { value: '10' } });
    fireEvent.pointerUp(slider);
    expect(handlers.onBudgetPercentCommit).toHaveBeenLastCalledWith(10);
  });

  it('keeps a legacy absolute cap effective and removable only explicitly', () => {
    const { handlers } = renderSettings({ pr_review_max_context_tokens: 120000 });

    expect(screen.getByRole('note')).toHaveTextContent('A legacy absolute cap of 120,000 tokens is still in effect.');
    expect(screen.getByTestId('review-context-budget-allowance')).toHaveTextContent('≈ 120K input tokens');
    expect(screen.getByTestId('review-context-budget-allowance')).toHaveTextContent('limited by the legacy cap');

    fireEvent.change(screen.getByRole('slider', { name: 'Review context budget' }), { target: { value: '100' } });
    expect(handlers.onRemoveLegacyCap).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove legacy cap' }));
    expect(handlers.onRemoveLegacyCap).toHaveBeenCalledTimes(1);
  });
});

describe('review context budget settings reload', () => {
  const load = (settings: Record<string, unknown>) => parseLoadedData([
    settings, {}, {}, {}, {}, { agents: [] }, {}, {},
  ]).settings;

  it('treats a missing or legacy zero percentage as automatic 100%', () => {
    expect(load({}).pr_review_context_budget_percent).toBe(100);
    expect(load({ pr_review_context_budget_percent: 0 }).pr_review_context_budget_percent).toBe(100);
  });

  it('reloads a saved percentage and a retained legacy cap', () => {
    const settings = load({ pr_review_context_budget_percent: 40, pr_review_max_context_tokens: 120000 });
    expect(settings.pr_review_context_budget_percent).toBe(40);
    expect(settings.pr_review_max_context_tokens).toBe(120000);
  });
});
