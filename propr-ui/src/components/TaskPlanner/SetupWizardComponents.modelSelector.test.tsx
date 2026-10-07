import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCatalogAgent } from '@propr/shared';
import { getInstanceCatalog } from '../../api/proprApi';
import { ModelSelector } from './SetupWizardComponents';
import { resolveInstanceDefaultModel } from './useInstanceDefaultModel';

vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));

const agents: InstanceCatalogAgent[] = [
  { alias: 'claude', enabled: true, supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' },
];

describe('resolveInstanceDefaultModel', () => {
  it('prefers the planner model override, then the default agent and its default model', () => {
    expect(resolveInstanceDefaultModel({ agents, defaultAgentAlias: 'claude', plannerGenerationModel: 'claude:claude-sonnet-5-5' })).toBe('claude:claude-sonnet-5-5');
    expect(resolveInstanceDefaultModel({ agents, defaultAgentAlias: 'claude' })).toBe('claude:claude-opus-5-5');
    expect(resolveInstanceDefaultModel({ agents: [{ ...agents[0], alias: 'default' }] })).toBe('default:claude-opus-5-5');
    expect(resolveInstanceDefaultModel({ agents })).toBeNull();
  });
});

describe('ModelSelector', () => {
  beforeEach(() => {
    vi.mocked(getInstanceCatalog).mockResolvedValue({ agents, repositories: [], defaultAgentAlias: 'claude' });
  });

  it('names the configured default model on the button instead of a bare "Default"', async () => {
    render(<ModelSelector agents={agents} generationModel={null} onModelChange={vi.fn()} />);
    const trigger = screen.getByTestId('planner-model-selector');
    await waitFor(() => expect(trigger).toHaveTextContent('Claude Opus 5.5 (Default)'));
    expect(screen.getByText('Model:')).toBeInTheDocument();

    fireEvent.click(trigger);
    const options = screen.getAllByRole('option');
    // The default row already is Claude Opus 5.5, so the menu doesn't list it a second time.
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Claude Opus 5.5 (Default)');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveTextContent('Claude Sonnet 5.5');
  });

  it('labels a plan-level default as the plan default and reports explicit picks', async () => {
    const onModelChange = vi.fn();
    render(<ModelSelector agents={agents} generationModel={null} onModelChange={onModelChange} defaultModel="claude:claude-sonnet-5-5" />);
    const trigger = screen.getByTestId('planner-model-selector');
    expect(trigger).toHaveTextContent('Claude Sonnet 5.5 (Default)');

    fireEvent.click(trigger);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Claude Sonnet 5.5 (Default)');
    fireEvent.click(screen.getByRole('option', { name: /Claude Opus 5\.5\s*claude$/ }));
    expect(onModelChange).toHaveBeenCalledWith('claude:claude-opus-5-5');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('treats an explicit pick of the default model as the default row', () => {
    render(<ModelSelector agents={agents} generationModel="claude:claude-sonnet-5-5" defaultModel="claude:claude-sonnet-5-5" onModelChange={vi.fn()} />);
    const trigger = screen.getByTestId('planner-model-selector');
    expect(trigger).toHaveTextContent('Claude Sonnet 5.5 (Default)');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Claude Sonnet 5.5 (Default)');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('shows the explicit model without the default suffix once one is chosen', () => {
    render(<ModelSelector agents={agents} generationModel="claude:claude-sonnet-5-5" onModelChange={vi.fn()} />);
    expect(screen.getByTestId('planner-model-selector')).toHaveTextContent(/^Claude Sonnet 5\.5$/);
  });

  it('never falls back to a bare "Default" while the catalog loads or when it names no default', async () => {
    let resolveCatalog: (value: Awaited<ReturnType<typeof getInstanceCatalog>>) => void = () => {};
    vi.mocked(getInstanceCatalog).mockReturnValue(new Promise(resolve => { resolveCatalog = resolve; }));
    render(<ModelSelector agents={agents} generationModel={null} onModelChange={vi.fn()} fullWidth />);
    const trigger = screen.getByTestId('planner-model-selector');
    expect(trigger).toHaveTextContent(/^Resolving model…$/);
    resolveCatalog({ agents, repositories: [] });
    await waitFor(() => expect(trigger).toHaveTextContent(/^Configured Default$/));
    expect(trigger).not.toHaveTextContent(/^Default$/);
  });
});
