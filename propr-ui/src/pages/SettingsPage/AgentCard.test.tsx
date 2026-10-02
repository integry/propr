import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../api/proprApi';
import AgentCard from './AgentCard';

const agent: AgentConfig = {
  id: 'claude-1',
  type: 'claude',
  alias: 'claude',
  enabled: true,
  dockerImage: 'propr/agent:test',
  configPath: '~/.claude',
  supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-6'],
  defaultModel: 'claude-opus-5-5',
};

function renderCard(overrides: Partial<React.ComponentProps<typeof AgentCard>> = {}) {
  const callbacks = {
    onLogin: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggle: vi.fn(),
    onSelectModel: vi.fn(),
  };
  render(<AgentCard agent={agent} {...callbacks} {...overrides} />);
  return callbacks;
}

afterEach(() => vi.unstubAllGlobals());

describe('AgentCard', () => {
  it('copies one short alias per model and exposes the canonical ID in its tooltip', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const callbacks = renderCard();
    const chip = screen.getByRole('button', { name: 'Copy opus55' });
    expect(chip).toHaveTextContent('opus55');
    expect(chip).toHaveAttribute('title', expect.stringContaining('claude-opus-5-5'));
    expect(screen.queryByText('claude-opus-5-5')).not.toBeInTheDocument();
    expect(screen.queryByText('ID / Alias')).not.toBeInTheDocument();
    expect(screen.queryByText('Context')).not.toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();

    fireEvent.click(chip);
    await waitFor(() => expect(chip).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledWith('opus55');
    expect(callbacks.onSelectModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Select Claude Opus 5.5 from claude in Playground' }));
    expect(callbacks.onSelectModel).toHaveBeenCalledWith(agent.id, 'claude-opus-5-5');
  });

  it('falls back to copying a custom model ID when no alias exists and reports clipboard failure', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard unavailable'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderCard({ agent: { ...agent, supportedModels: ['custom-model'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy custom-model' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Could not copy custom-model'));
    expect(writeText).toHaveBeenCalledWith('custom-model');
  });

  it('folds a provider independently and retains its legacy-model disclosure state', () => {
    renderCard();
    expect(screen.getByText('(2 models)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 legacy model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse claude models' }));
    expect(screen.queryByRole('button', { name: 'Copy opus55' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand claude models' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Expand claude models' }));
    expect(screen.getByRole('button', { name: 'Copy opus46' })).toBeVisible();
  });

  it.each(['vibe', 'antigravity', 'opencode'] as const)('starts %s collapsed without disabling its toggle', type => {
    const callbacks = renderCard({ agent: { ...agent, type, alias: type } });
    expect(screen.getByRole('button', { name: `Expand ${type} models` })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Copy opus55' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: `Enable ${type}` }));
    expect(callbacks.onToggle).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: `Expand ${type} models` })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: `Expand ${type} models` }));
    expect(screen.getByRole('button', { name: 'Copy opus55' })).toBeVisible();
  });

  it('keeps administrative actions in an overflow menu with keyboard navigation and dismissal', () => {
    const callbacks = renderCard();
    const trigger = screen.getByRole('button', { name: 'More actions for claude' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const login = screen.getByRole('menuitem', { name: 'Log in' });
    expect(login).toHaveFocus();
    fireEvent.keyDown(login, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Edit path' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    for (const [label, callback] of [
      ['Log in', callbacks.onLogin],
      ['Edit path', callbacks.onEdit],
      ['Delete provider', callbacks.onDelete],
    ] as const) {
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('menuitem', { name: label }));
      expect(callback).toHaveBeenCalledOnce();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    }
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse claude models' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('allows inspection in read-only mode while disabling all administrative actions', () => {
    renderCard({ readOnly: true });
    expect(screen.getByRole('checkbox', { name: 'Enable claude' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for claude' }));
    within(screen.getByRole('menu')).getAllByRole('menuitem').forEach(item => expect(item).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Collapse claude models' }));
    expect(screen.getByRole('button', { name: 'Expand claude models' })).toBeEnabled();
  });

  it('omits login for providers that do not support it', () => {
    renderCard({ agent: { ...agent, type: 'vibe', alias: 'vibe' } });
    fireEvent.click(screen.getByRole('button', { name: 'More actions for vibe' }));
    expect(screen.queryByRole('menuitem', { name: 'Log in' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit path' })).toBeEnabled();
  });
});
