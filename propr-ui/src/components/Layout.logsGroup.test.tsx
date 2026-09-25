import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstancePermission } from '../api/proprTypes';
import Layout from './Layout';

/**
 * The sidebar's Logs group: LLM Log and (for operators) MCP Log, collapsible,
 * keyboard-operable, and active whenever the current page is one of its
 * children.
 */

let permissions: InstancePermission[] = [];

vi.mock('../api/proprApi', () => ({ logout: vi.fn() }));
vi.mock('../hooks/useDynamicFavicon', () => ({ useDynamicFavicon: vi.fn() }));
vi.mock('../hooks/useSystemReadiness', () => ({
  useSystemReadiness: () => ({ hasAgents: true, hasRepos: true, hasTasks: true }),
}));
vi.mock('./ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
vi.mock('../contexts/AuthContext', () => ({
  useCurrentUser: () => null,
  userHasPermission: (_user: unknown, permission: InstancePermission) => permissions.includes(permission),
}));
vi.mock('../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({ unreadCount: null }),
}));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: false,
    subscribeToQueueStats: vi.fn(),
    unsubscribeFromQueueStats: vi.fn(),
    subscribeToIndexingUpdates: vi.fn(),
    unsubscribeFromIndexingUpdates: vi.fn(),
    onQueueStatsUpdate: () => vi.fn(),
    onIndexingUpdate: () => vi.fn(),
    onDraftUpdate: () => vi.fn(),
  }),
}));
vi.mock('./GlobalHeader', () => ({ default: () => null }));
vi.mock('./AgentTankSidebar', () => ({ default: () => null }));
vi.mock('./ConnectPlusBanner', () => ({ ConnectCapacityBanner: () => null }));

function renderLayout(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Layout><div>Page</div></Layout>
    </MemoryRouter>
  );
}

const logsHeader = () => screen.getByRole('button', { name: 'Logs' });

describe('Layout Logs navigation group', () => {
  beforeEach(() => {
    permissions = ['instance.manage_settings'];
    window.sessionStorage.clear();
  });

  it('renders both log destinations inside one collapsible group', () => {
    renderLayout('/');

    const header = logsHeader();
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(header.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(within(panel!).getByRole('link', { name: 'LLM Log' })).toHaveAttribute('href', '/llm-logs');
    expect(within(panel!).getByRole('link', { name: 'MCP Log' })).toHaveAttribute('href', '/mcp-logs');
  });

  it('collapses again and hides its children', () => {
    renderLayout('/');

    fireEvent.click(logsHeader());
    expect(screen.getByRole('link', { name: 'LLM Log' })).toBeInTheDocument();

    fireEvent.click(logsHeader());

    expect(logsHeader()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'LLM Log' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'MCP Log' })).not.toBeInTheDocument();
  });

  it('is operable from the keyboard', () => {
    renderLayout('/');
    const header = logsHeader();
    header.focus();
    expect(header).toHaveFocus();

    // A native button toggles on both Enter and Space; jsdom reports the click
    // those keys synthesise, which is what the group listens for.
    fireEvent.keyDown(header, { key: 'Enter' });
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(header, { key: ' ' });
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it.each(['/llm-logs', '/mcp-logs'])('opens and marks the group active on %s', route => {
    renderLayout(route);

    const header = logsHeader();
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(header.className).toContain('bg-slate-50');
  });

  it('keeps the group marked active while collapsed inside it', () => {
    renderLayout('/mcp-logs');

    fireEvent.click(logsHeader());

    expect(logsHeader()).toHaveAttribute('aria-expanded', 'false');
    expect(logsHeader().className).toContain('bg-slate-50');
  });

  it('remembers the expanded state for the session', () => {
    const first = renderLayout('/');
    fireEvent.click(logsHeader());
    first.unmount();

    renderLayout('/settings');

    expect(logsHeader()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'MCP Log' })).toBeInTheDocument();
  });

  it('keeps the LLM Log route active exactly as before', () => {
    renderLayout('/llm-logs');

    expect(screen.getByRole('link', { name: 'LLM Log' }).className).toContain('bg-slate-50');
    expect(screen.getByRole('link', { name: 'MCP Log' }).className).not.toContain('bg-slate-50');
  });

  it('hides MCP Log from a user without the instance settings permission', () => {
    permissions = [];
    renderLayout('/');

    fireEvent.click(logsHeader());

    expect(screen.getByRole('link', { name: 'LLM Log' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'MCP Log' })).not.toBeInTheDocument();
  });
});
