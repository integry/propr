import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MultiSelectMode } from './AgentModelSelectorParts';

describe('MultiSelectMode responsive layout', () => {
  it('keeps multi-agent execution controls shrinkable and wrappable', () => {
    render(
      <MultiSelectMode
        compact
        disabled={false}
        className=""
        selectedModels={[
          { agent_alias: 'codex', model_name: 'gpt-5.6-sol' },
          { agent_alias: 'claude', model_name: 'claude-sonnet-5' },
          { agent_alias: 'vibe', model_name: 'mistral-medium-3.5' },
        ]}
        allAgentModelPairs={[]}
        multiDropdownOpen={false}
        setMultiDropdownOpen={vi.fn()}
        onMultiModelToggle={vi.fn()}
        onBackToSingle={vi.fn()}
      />,
    );

    const selector = screen.getByTitle('Select multiple agent/model combinations').parentElement?.parentElement;
    expect(selector).toHaveClass('min-w-0', 'flex-wrap');

    const chips = screen.getByText('GPT-5.6 Sol').parentElement?.parentElement;
    expect(chips).toHaveClass('min-w-0', 'flex-1', 'flex-wrap');
    expect(screen.getByText('GPT-5.6 Sol').parentElement).toHaveClass('max-w-full', 'min-w-0');
  });
});
