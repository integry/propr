import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AIModelSelectionSection from './AIModelSelectionSection';

describe('AIModelSelectionSection', () => {
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
          pr_review_prompt: ''
        }}
        summarizationSettings={{ enabled: true, agent_alias: '' }}
        agents={[]}
        onSettingChange={vi.fn()}
        onReviewPromptChange={vi.fn()}
        onReviewPromptBlur={vi.fn()}
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
});
