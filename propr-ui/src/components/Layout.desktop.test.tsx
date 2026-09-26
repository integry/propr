import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopContext, type DesktopContextValue } from '../desktop/DesktopContext';
import Layout from './Layout';
import { DESKTOP_UI_COMMAND_EVENT } from '../desktop/useDesktopNativeCommands';

const mocks = vi.hoisted(() => ({
  canManage: false,
  hasRepos: true,
  logout: vi.fn(),
  openProfileManager: vi.fn(),
  retry: vi.fn(),
  reportConnectedRendererReady: vi.fn(async () => undefined),
  socket: {
    isConnected: true,
    subscribeToQueueStats: vi.fn(),
    unsubscribeFromQueueStats: vi.fn(),
    subscribeToIndexingUpdates: vi.fn(),
    unsubscribeFromIndexingUpdates: vi.fn(),
    onQueueStatsUpdate: vi.fn(() => vi.fn()),
    onIndexingUpdate: vi.fn(() => vi.fn()),
    onDraftUpdate: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../api/proprApi', () => ({ logout: mocks.logout }));
vi.mock('../hooks/useDynamicFavicon', () => ({ useDynamicFavicon: vi.fn() }));
vi.mock('../hooks/useSystemReadiness', () => ({
  useSystemReadiness: () => ({ hasAgents: true, hasRepos: mocks.hasRepos, hasTasks: true }),
}));
vi.mock('./ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('./GlobalHeader', () => ({ default: () => <header className="desktop-content-toolbar" aria-label="Application toolbar" data-testid="global-header">GitHub user</header> }));
vi.mock('./AgentTankSidebar', () => ({ default: () => null }));
vi.mock('../contexts/useSocket', () => ({ useSocket: () => mocks.socket }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
vi.mock('../contexts/AuthContext', () => ({
  useCurrentUser: () => ({ id: 'user-1', username: 'octocat' }),
  userHasPermission: () => mocks.canManage,
}));
vi.mock('./ConnectPlusBanner', () => ({ ConnectCapacityBanner: () => null }));
vi.mock('../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({ unreadCount: 0 }),
}));

const desktopValue = (overrides: Partial<DesktopContextValue> = {}): DesktopContextValue => ({
  isDesktop: true,
  platform: 'linux',
  profile: {
    id: 'local',
    name: 'This computer',
    baseUrl: 'http://127.0.0.1:3000',
    kind: 'local',
  },
  connection: { status: 'ready' },
  openProfileManager: mocks.openProfileManager,
  authenticate: vi.fn(async () => undefined),
  openConnectionHelp: vi.fn(async () => undefined),
  retry: mocks.retry,
  reportConnectedRendererReady: mocks.reportConnectedRendererReady,
  ...overrides,
});

const renderLayout = (desktop: DesktopContextValue | null) => render(
  <MemoryRouter>
    <DesktopContext.Provider value={desktop}>
      <Layout><div>Page content</div></Layout>
    </DesktopContext.Provider>
  </MemoryRouter>,
);

describe('Layout desktop instance selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.socket.isConnected = true;
    mocks.canManage = false;
    mocks.hasRepos = true;
  });

  it('keeps version and copyright on web but out of the desktop sidebar', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const desktop = renderLayout(desktopValue());
    expect(document.querySelector('aside footer')).toBeNull();
    expect(screen.queryByText(`ProPR v${__APP_VERSION__}`)).not.toBeInTheDocument();
    fireEvent(window, new CustomEvent(DESKTOP_UI_COMMAND_EVENT, { detail: 'toggle-sidebar' }));
    expect(document.querySelector('aside')).toBeNull();
    fireEvent(window, new CustomEvent(DESKTOP_UI_COMMAND_EVENT, { detail: 'toggle-sidebar' }));
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    desktop.unmount();
    renderLayout(null);
    const webFooter = document.querySelector('aside footer');
    expect(webFooter).toHaveTextContent('Rinalds Uzkalns');
    expect(webFooter).toHaveTextContent(`v${__APP_VERSION__}`);
    fireEvent(window, new CustomEvent(DESKTOP_UI_COMMAND_EVENT, { detail: 'toggle-sidebar' }));
    expect(document.querySelector('aside')).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it('integrates the desktop drag surface into the application toolbar without a duplicate title row', async () => {
    renderLayout(desktopValue());

    expect(document.querySelector('.desktop-native-titlebar')).toBeNull();
    const shell = document.querySelector('.desktop-shell');
    expect(shell?.firstElementChild).toHaveClass('desktop-shell-content');
    expect(document.querySelector('.desktop-connected-drag-region')).toHaveAttribute('aria-hidden', 'true');
    const toolbar = screen.getByRole('banner', { name: 'Application toolbar' });
    expect(toolbar).toHaveClass('desktop-content-toolbar');
    expect(toolbar.closest('.desktop-main-content')).not.toBeNull();
    const selector = screen.getByRole('button', { name: 'Connected: This computer' });
    expect(selector.closest('aside')).not.toBeNull();
    expect(screen.queryByRole('img', { name: 'ProPR' })).not.toBeInTheDocument();
    expect(document.querySelector('.desktop-sidebar-header')).toBeNull();
    expect(selector).toHaveAccessibleDescription(/Local instance/);
    expect(selector.querySelector('small')).toBeNull();
    expect(selector.querySelector('.desktop-connection-dot')).toHaveAttribute('title', 'Connected');
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveClass(
      'mx-2',
      'rounded-[6px]',
      'border-0',
      'bg-black/5',
      'text-slate-900',
    );
    expect(screen.getByRole('link', { name: 'Dashboard' }).className).not.toMatch(/\bborder-l(?:-|\b)/);
    expect(screen.getByTestId('global-header')).toHaveTextContent('GitHub user');
    const profile = screen.getByText('@octocat').closest('.desktop-sidebar-profile');
    expect(profile?.closest('aside')).not.toBeNull();
    // The collapsible Logs group takes the flat LLM Log entry's place in the
    // resources zone, immediately ahead of Settings.
    const logsGroup = screen.getByRole('button', { name: 'Logs' });
    expect(logsGroup.parentElement?.nextElementSibling).toBe(
      screen.getByRole('link', { name: 'Settings' }),
    );
    fireEvent.click(logsGroup);
    expect(screen.getByRole('link', { name: 'LLM Log' })).toHaveAttribute('href', '/llm-logs');

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));
    expect(mocks.logout).toHaveBeenCalledOnce();

    fireEvent.click(selector);
    expect(mocks.openProfileManager).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.reportConnectedRendererReady).toHaveBeenCalledOnce());
  });

  it('preserves instance management and ProPR Connect identity while offline', () => {
    renderLayout(desktopValue({
      profile: {
        id: 'connect',
        name: 'Operations',
        baseUrl: 'https://t-operations.propr.dev',
        kind: 'remote',
      },
      connection: { status: 'offline', message: 'No route' },
    }));

    const selector = screen.getByRole('button', { name: 'Offline: Operations' });
    expect(selector).toHaveAccessibleDescription(/ProPR Connect/);
    expect(selector.querySelector('.desktop-connection-dot')).toHaveAttribute('title', 'Offline');
    fireEvent.click(selector);
    expect(mocks.openProfileManager).toHaveBeenCalledOnce();
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it('uses the scoped transport for reconnecting and recovers without replacing the profile', async () => {
    mocks.socket.isConnected = false;
    const desktop = desktopValue();
    const view = renderLayout(desktop);

    const reconnecting = screen.getByRole('button', { name: 'Reconnecting: This computer' });
    expect(reconnecting.querySelector('.desktop-connection-dot')).toHaveAttribute('title', 'Reconnecting');
    fireEvent.click(reconnecting);
    expect(mocks.openProfileManager).toHaveBeenCalledOnce();
    expect(mocks.retry).not.toHaveBeenCalled();

    mocks.socket.isConnected = true;
    view.rerender(
      <MemoryRouter>
        <DesktopContext.Provider value={desktop}>
          <Layout><div>Page content</div></Layout>
        </DesktopContext.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Connected: This computer' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.reportConnectedRendererReady).toHaveBeenCalledOnce());
  });

  it('keeps Coding Agents and Access in the resource group for permitted users', () => {
    mocks.canManage = true;
    renderLayout(desktopValue());
    expect(screen.getByRole('link', { name: 'Coding Agents' })).toHaveAttribute('href', '/ai-agents');
    expect(screen.getByRole('link', { name: 'Access' })).toHaveAttribute('href', '/admin/members');
    expect(screen.getByRole('link', { name: 'Repositories' }).nextElementSibling).toBe(
      screen.getByRole('link', { name: 'Coding Agents' }),
    );
  });

  it('keeps restricted routes permission-gated on desktop', () => {
    renderLayout(desktopValue());
    expect(screen.queryByRole('link', { name: 'Coding Agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Access' })).not.toBeInTheDocument();
  });

  it('labels repository setup warnings in the trailing rail without emphasizing inactive text', () => {
    mocks.hasRepos = false;
    renderLayout(desktopValue());
    const indicator = screen.getByRole('img', { name: 'No repositories configured' });
    const row = indicator.closest('a');
    expect(indicator.parentElement).toBe(row?.lastElementChild);
    expect(indicator.parentElement).toHaveClass('items-center', 'justify-end');
    expect(indicator.querySelector('svg')).toHaveClass('lucide-triangle-alert');
    expect(row).toHaveClass('text-slate-600', 'hover:text-slate-900');
    expect(screen.getByText('Repositories')).not.toHaveClass('font-medium', 'text-slate-900');
  });

  it('leaves the browser layout free of desktop-only instance controls', () => {
    renderLayout(null);

    expect(screen.queryByText('Instance')).not.toBeInTheDocument();
    expect(document.querySelector('.desktop-instance-selector')).not.toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'ProPR' })).toBeInTheDocument();
  });
});
