import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpConnectedAppRow } from './McpConnectedAppRow';
import { McpConnectedAppsList } from './McpConnectedAppsList';
import {
  REPOSITORY_PREVIEW_LIMIT,
  orderScopes,
  repositoryOverflowLabel,
  visibleRepositories,
  type McpConnectedApp,
} from './mcpAppPresentation';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const repos = (count: number) => Array.from({ length: count }, (_, index) => `integry/repo-${index + 1}`);

const makeApp = (overrides: Partial<McpConnectedApp> = {}): McpConnectedApp => ({
  id: 'mcp-8f72a',
  name: 'Claude',
  scopes: ['read'],
  repositories: ['integry/mcptest'],
  connectedAt: hoursAgo(2),
  lastUsedAt: hoursAgo(1),
  ...overrides,
});

const renderRow = (app: McpConnectedApp, props: { revoking?: boolean; onRevoke?: (id: string) => void } = {}) =>
  render(<ul><McpConnectedAppRow app={app} onRevoke={props.onRevoke ?? vi.fn()} revoking={props.revoking} /></ul>);

describe('mcpAppPresentation', () => {
  it('orders scopes canonically, de-duplicates and puts unknown scopes last alphabetically', () => {
    expect(orderScopes(['manage', 'zeta', 'read', 'deploy', 'alpha', 'plan', 'merge', 'review', 'execute', 'publish', 'read']))
      .toEqual(['read', 'plan', 'publish', 'execute', 'review', 'merge', 'deploy', 'manage', 'alpha', 'zeta']);
  });

  it('truncates repositories to the preview limit after de-duplication', () => {
    expect(REPOSITORY_PREVIEW_LIMIT).toBe(10);
    const { visible, hiddenCount } = visibleRepositories([...repos(12), 'INTEGRY/REPO-1'], false);
    expect(visible).toHaveLength(10);
    expect(hiddenCount).toBe(2);
    expect(visibleRepositories(repos(12), true)).toEqual({ visible: repos(12), hiddenCount: 0 });
  });

  it('pluralizes the overflow label', () => {
    expect(repositoryOverflowLabel(1)).toBe('+ 1 more repository');
    expect(repositoryOverflowLabel(12)).toBe('+ 12 more repositories');
  });
});

describe('McpConnectedAppRow', () => {
  it('renders the header, metadata and the grant id as a code chip', () => {
    renderRow(makeApp());
    expect(screen.getByRole('heading', { name: 'Claude' })).toBeInTheDocument();
    expect(screen.getByText('Connected 2h ago')).toBeInTheDocument();
    expect(screen.getByText('Last used 1h ago')).toBeInTheDocument();
    const id = screen.getByText('mcp-8f72a');
    expect(id).toHaveClass('font-mono', 'bg-slate-100', 'border', 'border-slate-200', 'rounded-sm', 'truncate');
    expect(id).toHaveAttribute('title', 'mcp-8f72a');
  });

  it('shows "Never used" when the app has never been used', () => {
    renderRow(makeApp({ lastUsedAt: null }));
    expect(screen.getByText('Never used')).toBeInTheDocument();
    expect(screen.queryByText(/Last used/)).not.toBeInTheDocument();
  });

  it('renders scopes as ordered uppercase badges under a Permissions label', () => {
    renderRow(makeApp({ scopes: ['merge', 'custom', 'read', 'execute', 'plan'] }));
    const group = screen.getByRole('group', { name: 'Permissions' });
    const badges = within(group).getAllByRole('listitem').map(item => item.textContent);
    expect(badges).toEqual(['read', 'plan', 'execute', 'merge', 'custom']);
    expect(within(group).getByText('read')).toHaveClass('uppercase', 'text-[10px]', 'font-bold', 'text-slate-500', 'bg-slate-50');
    expect(screen.getByText('Permissions')).toHaveClass('uppercase', 'text-[10px]', 'font-bold', 'tracking-wider', 'text-slate-500');
  });

  it('collapses 25 repositories to 10 chips and toggles in place', () => {
    renderRow(makeApp({ repositories: repos(25) }));
    const group = screen.getByRole('group', { name: 'Repositories' });
    expect(within(group).getAllByRole('listitem')).toHaveLength(10);

    const toggle = within(group).getByRole('button', { name: '+ 15 more repositories' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(within(group).getAllByRole('listitem')).toHaveLength(25);
    expect(toggle).toHaveTextContent('Show fewer');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(within(group).getAllByRole('listitem')).toHaveLength(10);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses the singular label for one hidden repository and no toggle when nothing is hidden', () => {
    const { unmount } = renderRow(makeApp({ repositories: repos(11) }));
    expect(screen.getByRole('button', { name: '+ 1 more repository' })).toBeInTheDocument();
    unmount();
    renderRow(makeApp({ repositories: repos(10) }));
    expect(screen.queryByRole('button', { expanded: false })).not.toBeInTheDocument();
  });

  it('renders repository handles as truncating monospace chips with a full-value title', () => {
    const longName = 'integry/a-very-long-repository-name-1234';
    expect(longName).toHaveLength(40);
    renderRow(makeApp({ repositories: [longName] }));
    const chip = screen.getByText(longName);
    expect(chip).toHaveClass('font-mono', 'truncate', 'max-w-full');
    expect(chip).toHaveAttribute('title', longName);
  });

  it('calls onRevoke with the grant id from a destructive right-rail button', () => {
    const onRevoke = vi.fn();
    renderRow(makeApp(), { onRevoke });
    const button = screen.getByRole('button', { name: 'Revoke access for Claude (ID: mcp-8f72a)' });
    expect(button).toHaveClass('hover:border-red-200', 'hover:bg-red-50', 'hover:text-red-600');
    expect(button.parentElement).toHaveClass('justify-between');
    fireEvent.click(button);
    expect(onRevoke).toHaveBeenCalledWith('mcp-8f72a');
  });

  it('disables only the revoke button while a revoke is in flight', () => {
    const onRevoke = vi.fn();
    renderRow(makeApp({ repositories: repos(12) }), { revoking: true, onRevoke });
    const button = screen.getByRole('button', { name: /Revoke access/ });
    expect(button).toBeDisabled();
    expect(button.querySelector('.animate-spin')).not.toBeNull();
    fireEvent.click(button);
    expect(onRevoke).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '+ 2 more repositories' })).toBeEnabled();
  });
});

describe('McpConnectedAppsList', () => {
  it('gives every same-named app a distinct revoke name on a card-free surface', () => {
    const apps = ['mcp-1', 'mcp-2', 'mcp-3', 'mcp-4'].map(id => makeApp({ id }));
    render(<McpConnectedAppsList apps={apps} onRevoke={vi.fn()} revokingId="mcp-3" />);
    const list = screen.getByRole('list', { name: 'Connected apps' });
    expect(list).toHaveClass('bg-white');
    expect(list.className).not.toMatch(/shadow|rounded/);
    const buttons = screen.getAllByRole('button', { name: /^Revoke access for Claude/ });
    expect(new Set(buttons.map(button => button.getAttribute('aria-label'))).size).toBe(4);
    expect(screen.getByRole('button', { name: /mcp-3/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /mcp-4/ })).toBeEnabled();
    for (const row of list.children) expect(row).toHaveClass('border-b', 'border-slate-100');
  });

  it('renders loading and empty states', () => {
    const { rerender } = render(<McpConnectedAppsList apps={[]} onRevoke={vi.fn()} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading connected apps');
    rerender(<McpConnectedAppsList apps={[]} onRevoke={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('No connected apps.');
  });
});
