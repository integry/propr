import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../api/proprTypes';
import GlobalHeader from './GlobalHeader';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  headerStats: {
    runningCount: 0,
    runningItems: [],
    activityStatus: 'available',
    activePlans: [],
    reviewCount: 1,
    reviewGroups: [{
      key: 'task-1',
      repoOwner: 'propr',
      repoName: 'desktop',
      latestTask: {
        id: 'task-1',
        status: 'completed',
        createdAt: '2026-09-09T20:00:00.000Z',
        title: 'Native shell',
      },
      allTasks: [],
    }],
    systemHealth: {
      daemon: 'Running',
      workers: 'Running',
      redis: 'Connected',
      githubAuth: 'Authenticated',
      claudeAuth: 'Ready',
      indexing: 'Idle',
      githubEventIntake: 'ProPR Connect',
      githubEventIntakeStatus: 'Connected',
      agents: [],
      isHealthy: true,
    },
    isLoading: false,
    error: null,
    dismissPlan: vi.fn(),
    dismissTask: vi.fn(),
    dismissedPlanIds: [],
    dismissedTaskIds: [],
    clearDismissedPlans: vi.fn(),
    clearDismissedTasks: vi.fn(),
    refresh: vi.fn(async () => undefined),
  },
}));

vi.mock('../hooks/useHeaderStats', () => ({
  useHeaderStats: () => mocks.headerStats,
}));
vi.mock('../hooks/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    query: '',
    results: { plans: [], tasks: [], repositories: [] },
    isLoading: false,
    isOpen: false,
    hasResults: false,
    setQuery: vi.fn(),
    clearSearch: vi.fn(),
    setIsOpen: vi.fn(),
  }),
}));
vi.mock('./MobileBottomNavigation', () => ({ default: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

const user: CurrentUser = {
  id: 'user-1',
  login: 'octocat',
  username: 'octocat',
  displayName: 'The Octocat',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: [],
  authorizationSource: 'local',
};

describe('GlobalHeader desktop toolbar', () => {
  beforeEach(() => {
    mocks.navigate.mockClear();
  });

  const renderToolbar = (route = '/') => {
    const router = createMemoryRouter([{ path: '*', element: (
        <GlobalHeader
          user={user}
          onLogout={vi.fn()}
          onMenuToggle={vi.fn()}
          MenuIcon={() => null}
        />
    ) }], { initialEntries: [route] });
    const { container } = render(<RouterProvider router={router} />);
    const toolbar = container.querySelector<HTMLElement>('header.desktop-content-toolbar')!;
    const [left, right] = Array.from(toolbar.children) as HTMLElement[];
    return { toolbar, left, right, router };
  };

  it.each([
    ['/', 'New Task', '/tasks/new', 'lucide-zap', ['New Plan', 'New Goal']],
    ['/tasks/task-1', 'New Task', '/tasks/new', 'lucide-zap', ['New Plan', 'New Goal']],
    ['/plans', 'New Plan', '/studio/new', 'lucide-scroll-text', ['New Task', 'New Goal']],
    ['/studio/draft-1', 'New Plan', '/studio/new', 'lucide-scroll-text', ['New Task', 'New Goal']],
    ['/goals', 'New Goal', '/goals?new=1', 'lucide-target', ['New Task', 'New Plan']],
    ['/goals/goal-1?tab=activity#latest', 'New Goal', '/goals?new=1', 'lucide-target', ['New Task', 'New Plan']],
  ])('uses the route action and remaining menu options on %s', (route, label, to, icon, options) => {
    renderToolbar(route);
    const primary = screen.getByRole('button', { name: label });
    expect(primary.querySelector('svg')).toHaveClass(icon);
    fireEvent.click(primary);
    expect(mocks.navigate).toHaveBeenLastCalledWith(to);

    const destinations: Record<string, string> = {
      'New Task': '/tasks/new', 'New Plan': '/studio/new', 'New Goal': '/goals?new=1',
    };
    const icons: Record<string, string> = {
      'New Task': 'lucide-zap', 'New Plan': 'lucide-scroll-text', 'New Goal': 'lucide-target',
    };
    for (const option of options) {
      fireEvent.click(screen.getByRole('button', { name: 'More creation options' }));
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(options);
      const menuItem = screen.getByRole('menuitem', { name: option });
      expect(menuItem.querySelector('svg')).toHaveClass(icons[option]);
      fireEvent.click(menuItem);
      expect(mocks.navigate).toHaveBeenLastCalledWith(destinations[option]);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    }
  });

  it('follows client navigation and history while keeping the menu in sync', async () => {
    const { router } = renderToolbar('/plans');
    fireEvent.click(screen.getByRole('button', { name: 'More creation options' }));
    const expectActions = (primary: string, options: string[]) => {
      expect(screen.getByRole('button', { name: primary })).toBeInTheDocument();
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(options);
    };
    await act(() => router.navigate('/goals/goal-1'));
    expectActions('New Goal', ['New Task', 'New Plan']);
    await act(() => router.navigate('/repositories'));
    expectActions('New Task', ['New Plan', 'New Goal']);
    await act(() => router.navigate(-1));
    expectActions('New Goal', ['New Task', 'New Plan']);
    await act(() => router.navigate(-1));
    expectActions('New Plan', ['New Task', 'New Goal']);
    await act(() => router.navigate(1));
    expectActions('New Goal', ['New Task', 'New Plan']);
  });

  it('leads with search, puts the page scope control beside it, and keeps app actions right', () => {
    const { toolbar, left, right } = renderToolbar();

    expect(toolbar).toHaveAccessibleName('Application toolbar');
    // Two regions now: the centred middle column had nothing left to centre.
    expect(toolbar).toHaveClass('bg-slate-50', 'md:flex');
    expect(toolbar.children).toHaveLength(2);

    // The in-focus menus are gone: the sidebar already carries these counts.
    expect(within(toolbar).queryByRole('button', { name: '0 Plans' })).not.toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: '1 Task' })).not.toBeInTheDocument();

    // Search is the primary input, so it leads the bar from the left.
    expect(within(left).getByRole('textbox', { name: 'Search' })).toHaveClass('border-0', 'bg-slate-100');
    expect(within(left).getByText('\u2318K')).toBeInTheDocument();

    // The menu toggle stays available as the drawer trigger below `lg`.
    const menuToggle = within(left).getByRole('button', { name: 'Open menu' });
    expect(menuToggle).toHaveClass('lg:hidden');
    expect(left.firstElementChild).toBe(menuToggle);

    // The repository selector mounts immediately after search and collapses
    // to nothing on pages that have no repository scope to offer.
    const searchWrapper = within(left).getByTestId('header-search');
    const scopeSlot = within(left).getByTestId('header-scope-slot');
    expect(scopeSlot.previousElementSibling).toBe(searchWrapper);
    expect(left.lastElementChild).toBe(scopeSlot);
    expect(scopeSlot).toBeEmptyDOMElement();
    expect(scopeSlot).toHaveClass('hidden', 'lg:flex', 'lg:empty:hidden');

    // The action region never shrinks, so search is what yields at 768px.
    expect(left).toHaveClass('min-w-0', 'flex-1');
    expect(right).toHaveClass('flex-none');
    expect(within(right).getByRole('button', { name: 'Quick add to-do' })).toBeInTheDocument();
    expect(within(right).getByRole('button', { name: 'System Status' })).toBeInTheDocument();

    expect(within(toolbar).queryByText('The Octocat')).not.toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: 'Logout' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Inbox' })).not.toBeInTheDocument();
  });

  it('draws the caret inside the New Task button rather than beside it', () => {
    const { right } = renderToolbar();

    const newTask = within(right).getByRole('button', { name: 'New Task' });
    const caret = within(right).getByRole('button', { name: 'More creation options' });
    // One filled, clipped shell owns both halves: the caret cannot read as a
    // stray glyph floating next to the button when it shares its container.
    expect(caret.parentElement).toBe(newTask.parentElement);
    expect(newTask.parentElement).toHaveClass('bg-teal-600', 'rounded-lg', 'overflow-hidden');
    expect(caret).toHaveAttribute('aria-haspopup', 'menu');
    expect(caret).toHaveAttribute('aria-expanded', 'false');
    // A hairline divider sits between the two halves.
    expect(newTask.nextElementSibling).toHaveClass('w-px');
  });

  it.each([
    ['an outside pointer press', () => fireEvent.pointerDown(document.body)],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
  ])('closes the creation menu on %s', (_label, dismiss) => {
    const { right } = renderToolbar();
    const caret = within(right).getByRole('button', { name: 'More creation options' });

    fireEvent.click(caret);
    expect(screen.getByRole('menu', { name: 'More creation options' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'New Plan' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'New Goal' })).toBeInTheDocument();
    expect(caret).toHaveAttribute('aria-expanded', 'true');

    // The `<details>` element this replaced could not do either of these.
    dismiss();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(caret).toHaveAttribute('aria-expanded', 'false');
  });

  it('navigates and closes the menu when a creation option is chosen', () => {
    const { right } = renderToolbar();
    const caret = within(right).getByRole('button', { name: 'More creation options' });

    fireEvent.click(caret);
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Plan' }));

    expect(mocks.navigate).toHaveBeenCalledWith('/studio/new');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(caret);
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Goal' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/goals?new=1');

    fireEvent.click(within(right).getByRole('button', { name: 'New Task' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/tasks/new');
  });

  it.each([['/', 'New Task'], ['/plans', 'New Plan'], ['/goals', 'New Goal']])('keeps creation inert in demo mode on %s', (route, label) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <GlobalHeader
          user={user}
          onLogout={vi.fn()}
          onMenuToggle={vi.fn()}
          MenuIcon={() => null}
          isDemoMode
        />
      </MemoryRouter>,
    );

    const newTask = screen.getByRole('button', { name: label });
    expect(newTask).toBeDisabled();
    expect(newTask).toHaveAttribute('title', 'Demo mode is read-only');
    expect(newTask.parentElement).toHaveClass('bg-gray-300');

    const caret = screen.getByRole('button', { name: 'More creation options' });
    expect(caret).toBeDisabled();

    // The menu is still reachable for assertion via the keyboard-free path in
    // other tests; here the disabled caret is what keeps it out of reach.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
