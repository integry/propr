import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentTankUsage, refreshAgentTank } from '../api/revertApi';
import type { CurrentUser } from '../api/proprTypes';
import type { HeaderStats } from '../hooks/useHeaderStats';
import MobileBottomNavigation from './MobileBottomNavigation';

vi.mock('../api/revertApi', () => ({
  getAgentTankUsage: vi.fn(),
  refreshAgentTank: vi.fn(),
}));

const mockGetAgentTankUsage = vi.mocked(getAgentTankUsage);
const mockRefreshAgentTank = vi.mocked(refreshAgentTank);

const user: CurrentUser = {
  id: 'user-1',
  login: 'octocat',
  username: 'octocat',
  displayName: 'The Octocat',
  email: 'octocat@example.com',
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_agents', 'instance.manage_members'],
  authorizationSource: 'local',
};

const systemHealth: HeaderStats['systemHealth'] = {
  daemon: 'Running',
  workers: 'Running',
  redis: 'Connected',
  githubAuth: 'Authenticated',
  claudeAuth: 'Ready',
  indexing: 'Idle',
  githubEventIntake: 'Polling',
  githubEventIntakeStatus: 'Active',
  agents: [],
  isHealthy: true,
};

const Location = () => {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
};

function renderNavigation(
  initialEntry = '/tasks/task-1',
  onLogout = vi.fn(),
  currentUser: CurrentUser | null = user,
  isDemoMode = false
) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <MobileBottomNavigation
        user={currentUser}
        onLogout={onLogout}
        isDemoMode={isDemoMode}
        unreadCount={7}
        systemHealth={systemHealth}
      />
      <Location />
    </MemoryRouter>
  );
  return { onLogout };
}

describe('MobileBottomNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentTankUsage.mockResolvedValue({ enabled: false });
    mockRefreshAgentTank.mockResolvedValue({ success: true });
  });

  it('renders all five destinations in order with the unread count and route active state', () => {
    renderNavigation('/');

    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    const destinations = within(navigation).getAllByText(/^(Inbox|Dashboard|New Task|Repositories|More)$/);

    expect(destinations.map(destination => destination.textContent)).toEqual([
      'Inbox',
      'Dashboard',
      'New Task',
      'Repositories',
      'More',
    ]);
    expect(within(navigation).getByText('7')).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('link', { name: /Inbox/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'More' })).not.toHaveAttribute('aria-current');
  });

  it('names the dashboard tab the way the sidebar does, with no second name for it', () => {
    renderNavigation('/');

    // One screen, one name: a tab reading "Activity" under a pulse icon sat
    // beside a sidebar and page that both say Dashboard.
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    const tab = within(navigation).getByRole('link', { name: 'Dashboard' });
    expect(tab).toHaveAttribute('href', '/');
    expect(tab.querySelector('svg')).toHaveClass('lucide-layout-dashboard');
    expect(within(navigation).queryByText('Activity')).not.toBeInTheDocument();
  });

  it('opens an accessible More sheet and restores focus after Escape and backdrop close', () => {
    renderNavigation();
    const moreButton = screen.getByRole('button', { name: 'More' });

    fireEvent.click(moreButton);

    const dialog = screen.getByRole('dialog', { name: 'More' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/tasks');
    expect(screen.getByRole('link', { name: 'Plans' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Coding Agents' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Logs' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Access' })).toBeInTheDocument();
    expect(screen.getByText('System health')).toBeInTheDocument();
    expect(screen.getByText('The Octocat')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'More' })).not.toBeInTheDocument();
    expect(moreButton).toHaveFocus();

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByTestId('mobile-more-backdrop'));

    expect(screen.queryByRole('dialog', { name: 'More' })).not.toBeInTheDocument();
    expect(moreButton).toHaveFocus();
  });

  it('closes on route navigation and marks More active for its destinations', () => {
    renderNavigation('/inbox');
    const moreButton = screen.getByRole('button', { name: 'More' });

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole('link', { name: 'Plans' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/plans');
    expect(screen.queryByRole('dialog', { name: 'More' })).not.toBeInTheDocument();
    expect(moreButton).toHaveAttribute('aria-current', 'page');
  });

  it.each(['/tasks', '/tasks/task-1', '/admin/members'])('marks More active for %s', route => {
    renderNavigation(route);

    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-current', 'page');
  });

  it('hides Access without member management permission', () => {
    renderNavigation('/tasks', vi.fn(), {
      ...user,
      permissions: ['instance.manage_agents'],
    });

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Access' })).not.toBeInTheDocument();
  });

  it('signs out from the identity section', () => {
    const { onLogout } = renderNavigation();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('shows Agent Tank usage for users with agent management permission', async () => {
    mockGetAgentTankUsage.mockResolvedValue({
      enabled: true,
      agents: {
        claude: {
          name: 'claude',
          usage: { session: { percent: 25, resetsIn: '2h' } },
        },
      },
    });

    renderNavigation();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(await screen.findByText('Usage')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByTitle('Refresh usage')).toBeInTheDocument();
  });

  it('hides Agent Tank usage without agent management permission outside demo mode', () => {
    mockGetAgentTankUsage.mockResolvedValue({
      enabled: true,
      agents: {
        claude: {
          name: 'claude',
          usage: { session: { percent: 25 } },
        },
      },
    });

    renderNavigation('/tasks', vi.fn(), { ...user, permissions: [] });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.queryByText('Usage')).not.toBeInTheDocument();
    expect(mockGetAgentTankUsage).not.toHaveBeenCalled();
  });

  it('shows Agent Tank usage without manual refresh in demo mode', async () => {
    mockGetAgentTankUsage.mockResolvedValue({
      enabled: true,
      agents: {
        codex: {
          name: 'codex',
          usage: { fiveHour: { percentUsed: 40, resetsIn: '3h' } },
        },
      },
    });

    renderNavigation('/tasks', vi.fn(), { ...user, permissions: [] }, true);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(await screen.findByText('Usage')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.queryByTitle('Refresh usage')).not.toBeInTheDocument();
  });

  it('expands and collapses the metric breakdown for an agent with multiple metrics', async () => {
    mockGetAgentTankUsage.mockResolvedValue({
      enabled: true,
      agents: {
        claude: {
          name: 'claude',
          usage: {
            session: { percent: 25, resetsIn: '2h' },
            weeklyAll: { percent: 50, resetsIn: '4d' },
          },
        },
      },
    });

    renderNavigation();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    const agentRow = await screen.findByRole('button', { name: /Claude/ });
    expect(agentRow).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Session')).not.toBeInTheDocument();
    expect(screen.queryByText('Weekly')).not.toBeInTheDocument();

    fireEvent.click(agentRow);

    expect(agentRow).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Session')).toBeInTheDocument();
    expect(screen.getByText('Weekly')).toBeInTheDocument();

    fireEvent.click(agentRow);

    expect(agentRow).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Session')).not.toBeInTheDocument();
  });
});
