import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentTankUsage, refreshAgentTank } from '../api/revertApi';
import type { CurrentUser } from '../api/proprTypes';
import type { HeaderStats } from '../hooks/useHeaderStats';
import MobileBottomNavigation from './MobileBottomNavigation';
import { getPrimaryMetric } from './agentTankMetrics';

vi.mock('../api/revertApi', () => ({
  getAgentTankUsage: vi.fn(),
  refreshAgentTank: vi.fn(),
}));
// The usage widget refreshes on `usage:update`; this suite never pushes one.
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: true,
    onActivityUpdate: () => () => undefined,
    onNotificationUpdate: () => () => undefined,
    onUsageUpdate: () => () => undefined,
  }),
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
  return <div data-testid="location">{location.pathname}{location.search}</div>;
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
    // Provider rows persist their expansion; start each test from no preference.
    window.localStorage.clear();
    mockGetAgentTankUsage.mockResolvedValue({ enabled: false });
    mockRefreshAgentTank.mockResolvedValue({ success: true });
  });

  it('renders Dashboard, Tasks, Create, Inbox and More in order with the unread count', () => {
    renderNavigation('/');

    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    const destinations = within(navigation).getAllByText(/^(Dashboard|Tasks|Create|Inbox|More)$/);

    expect(destinations.map(destination => destination.textContent)).toEqual([
      'Dashboard',
      'Tasks',
      'Create',
      'Inbox',
      'More',
    ]);
    expect(within(navigation).getByText('7')).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/tasks');
    expect(within(navigation).getByRole('link', { name: /Inbox/ })).not.toHaveAttribute('aria-current');
    expect(within(navigation).queryByRole('link', { name: 'Repositories' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).not.toHaveAttribute('aria-current');
  });

  it.each(['/', '/plans', '/goals/goal-1', '/automations/def-1'])(
    'offers every creation action from the Create sheet on %s', route => {
      renderNavigation(route);
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      const sheet = screen.getByRole('dialog', { name: 'Create' });
      const actions = within(sheet).getAllByRole('listitem').map(row => row.querySelector('a, button')!);
      expect(actions.map(action => [action.textContent, action.getAttribute('href')])).toEqual([
        ['New Task', '/tasks/new'],
        ['New Goal', '/goals?new=1'],
        ['New Plan', '/studio/new'],
        ['New Automation', '/automations/new'],
        ['New To-do', null],
      ]);
      expect(within(sheet).getByRole('button', { name: 'New To-do' })).toHaveAttribute('aria-expanded', 'false');
    },
  );

  it.each([
    ['New Task', '/tasks/new'],
    ['New Goal', '/goals?new=1'],
    ['New Plan', '/studio/new'],
    ['New Automation', '/automations/new'],
  ])('navigates to %s from the Create sheet and marks Create active', (label, to) => {
    renderNavigation('/inbox');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.click(screen.getByRole('link', { name: label }));
    expect(screen.getByTestId('location').textContent).toBe(to);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'More' })).not.toHaveAttribute('aria-current');
  });

  it('closes the Create sheet with Escape and restores focus', () => {
    renderNavigation('/');
    const create = screen.getByRole('button', { name: 'Create' });
    fireEvent.click(create);
    expect(screen.getByRole('dialog', { name: 'Create' })).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Create' })).not.toBeInTheDocument();
    expect(create).toHaveFocus();
  });

  it('disables Create in demo mode', () => {
    renderNavigation('/', vi.fn(), user, true);
    const create = screen.getByRole('button', { name: 'Create unavailable in demo mode' });
    expect(create).toBeDisabled();
    fireEvent.click(create);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps creation out of the More sheet', () => {
    renderNavigation('/');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const more = screen.getByRole('dialog', { name: 'ProPR' });
    expect(within(more).queryAllByRole('link', { name: /^New / })).toHaveLength(0);
  });

  it('brands the More sheet as ProPR with the decorative logo, while Create keeps its own name', () => {
    renderNavigation('/');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const more = screen.getByRole('dialog', { name: 'ProPR' });
    const heading = within(more).getByRole('heading', { level: 2, name: 'ProPR' });
    const logo = heading.querySelector('img');
    expect(logo).toHaveAttribute('src', '/logo.png');
    expect(logo).toHaveAttribute('alt', '');
    expect(within(more).queryByText('More')).not.toBeInTheDocument();
    fireEvent.click(within(more).getByRole('button', { name: 'Close ProPR menu' }));
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(within(screen.getByRole('dialog', { name: 'Create' })).getByRole('heading', { level: 2 }).querySelector('img')).toBeNull();
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

    const dialog = screen.getByRole('dialog', { name: 'ProPR' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Repositories' })).toHaveAttribute('href', '/repositories');
    expect(within(dialog).getByRole('link', { name: 'Automations' })).toHaveAttribute('href', '/automations');
    expect(within(dialog).getByRole('link', { name: 'Analytics' })).toHaveAttribute('href', '/analytics');
    expect(screen.getByRole('link', { name: 'Plans' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Coding Agents' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'LLM Log' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Access' })).toBeInTheDocument();
    expect(screen.getByText('System health')).toBeInTheDocument();
    expect(screen.getByText('The Octocat')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    // Identity leads the sheet instead of trailing every destination.
    expect(within(dialog).getByRole('button', { name: 'Sign out' }).compareDocumentPosition(
      within(dialog).getByRole('link', { name: 'Goals' }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([
      'Workspace',
      'Telemetry & system',
      'Configuration',
    ]);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'ProPR' })).not.toBeInTheDocument();
    expect(moreButton).toHaveFocus();

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByTestId('mobile-more-sheet-backdrop'));

    expect(screen.queryByRole('dialog', { name: 'ProPR' })).not.toBeInTheDocument();
    expect(moreButton).toHaveFocus();
  });

  it('closes on route navigation and marks More active for its destinations', () => {
    renderNavigation('/inbox');
    const moreButton = screen.getByRole('button', { name: 'More' });

    fireEvent.click(moreButton);
    fireEvent.click(screen.getByRole('link', { name: 'Plans' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/plans');
    expect(screen.queryByRole('dialog', { name: 'ProPR' })).not.toBeInTheDocument();
    expect(moreButton).toHaveAttribute('aria-current', 'page');
  });

  it.each(['/repositories', '/automations', '/analytics', '/admin/members', '/llm-logs', '/mcp-logs'])('marks More active for %s', route => {
    renderNavigation(route);

    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-current', 'page');
  });

  it.each(['/tasks', '/tasks/task-1'])('marks Tasks active for %s', route => {
    renderNavigation(route);

    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'More' })).not.toHaveAttribute('aria-current');
  });

  it('offers the MCP log only to operators who may read it', () => {
    renderNavigation('/tasks', vi.fn(), { ...user, permissions: ['instance.manage_settings'] });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByRole('link', { name: 'MCP Log' })).toHaveAttribute('href', '/mcp-logs');
  });

  it('hides the MCP log without the settings permission', () => {
    renderNavigation('/tasks', vi.fn(), { ...user, permissions: ['instance.manage_agents'] });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByRole('link', { name: 'LLM Log' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'MCP Log' })).not.toBeInTheDocument();
  });

  it('hides Access without member management permission', () => {
    renderNavigation('/tasks', vi.fn(), {
      ...user,
      permissions: ['instance.manage_agents'],
    });

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Access' })).not.toBeInTheDocument();
  });

  it('signs out from the identity section', () => {
    const { onLogout } = renderNavigation();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('condenses Agent Tank usage into one summary row for users with agent management permission', async () => {
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

    expect(await screen.findByText('API & quota usage')).toBeInTheDocument();
    expect(screen.getByTestId('usage-summary')).toHaveTextContent('Claude 25%');
    // The menu shows only the summary; the bars and refresh live in the Usage sheet.
    expect(screen.queryByText('Session')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Refresh usage')).not.toBeInTheDocument();
  });

  it('preserves quota pool names and formats model IDs through the mobile summary and Usage sheet', async () => {
    const agent = {
      name: 'antigravity',
      usage: {
        models: [
          { model: 'Claude and GPT · Weekly Limit Remaining', percentUsed: 12 },
          { model: 'claude-sonnet-9-1-20990101', percentUsed: 7 },
        ],
      },
    };
    mockGetAgentTankUsage.mockResolvedValue({ enabled: true, agents: { antigravity: agent } });

    // The summary's primary metric retains the product label before formatting model IDs.
    expect(getPrimaryMetric(agent)).toMatchObject({
      label: 'Weekly', group: 'Claude and GPT', title: 'Claude and GPT · Weekly Limit', percent: 12,
    });
    renderNavigation();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const summary = await screen.findByRole('button', { name: /API & quota usage/ });
    expect(screen.getByTestId('usage-summary')).toHaveTextContent('Antigravity 12%');
    expect(screen.queryByText('Weekly')).not.toBeInTheDocument();

    fireEvent.click(summary);
    const sheet = within(await screen.findByRole('dialog', { name: 'API & quota usage' }));
    expect(sheet.getByRole('button', { name: /Antigravity/ })).toHaveAttribute('aria-expanded', 'true');
    expect(sheet.getByText('Claude and GPT')).toBeInTheDocument();
    expect(sheet.getByText('Weekly')).toHaveAttribute('title', 'Claude and GPT · Weekly Limit');
    expect(sheet.getByText('Claude Sonnet 9.1')).toHaveAttribute('title', 'Claude Sonnet 9.1');
    expect(sheet.queryByText('claude-sonnet-9-1-20990101')).not.toBeInTheDocument();
    expect(sheet.queryByTitle('claude-sonnet-9-1-20990101')).not.toBeInTheDocument();
    expect(agent.usage.models[1].model).toBe('claude-sonnet-9-1-20990101');
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

    expect(screen.queryByText('API & quota usage')).not.toBeInTheDocument();
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

    expect(await screen.findByText('API & quota usage')).toBeInTheDocument();
    expect(screen.getByTestId('usage-summary')).toHaveTextContent('Codex 40%');
    fireEvent.click(screen.getByRole('button', { name: /API & quota usage/ }));
    expect(await screen.findByRole('dialog', { name: 'API & quota usage' })).toBeInTheDocument();
    expect(screen.queryByTitle('Refresh usage')).not.toBeInTheDocument();
  });

  it('drills from the usage row into a Usage sheet and back', async () => {
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
        codex: {
          name: 'codex',
          usage: { fiveHour: { percentUsed: 7, resetsIn: '3h' } },
        },
      },
    });

    renderNavigation();
    const moreButton = screen.getByRole('button', { name: 'More' });
    fireEvent.click(moreButton);
    fireEvent.click(await screen.findByRole('button', { name: /API & quota usage/ }));

    expect(screen.queryByRole('dialog', { name: 'ProPR' })).not.toBeInTheDocument();
    const usageSheet = await screen.findByRole('dialog', { name: 'API & quota usage' });
    // Opened to read the numbers, so every provider starts expanded.
    expect(within(usageSheet).getByRole('button', { name: /Claude/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(usageSheet).getByRole('button', { name: /Codex/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(usageSheet).getByText('Weekly')).toBeInTheDocument();
    expect(within(usageSheet).getByTitle('Refresh usage')).toBeInTheDocument();

    fireEvent.click(within(usageSheet).getByRole('button', { name: 'Back to ProPR menu' }));
    expect(screen.queryByRole('dialog', { name: 'API & quota usage' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'ProPR' })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /API & quota usage/ }));
    await screen.findByRole('dialog', { name: 'API & quota usage' });
    fireEvent.click(screen.getByTestId('mobile-usage-sheet-backdrop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(moreButton).toHaveFocus();
  });
});
