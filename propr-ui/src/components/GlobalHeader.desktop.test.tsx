import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../api/proprTypes';
import GlobalHeader from './GlobalHeader';

const mocks = vi.hoisted(() => ({
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
  it('keeps counters left, search centered, and app actions on the right without account chrome', () => {
    const { container } = render(
      <MemoryRouter>
        <GlobalHeader
          user={user}
          onLogout={vi.fn()}
          onMenuToggle={vi.fn()}
          MenuIcon={() => null}
        />
      </MemoryRouter>,
    );

    const toolbar = container.querySelector<HTMLElement>('header.desktop-content-toolbar');
    expect(toolbar).toHaveAccessibleName('Application toolbar');
    expect(toolbar).toHaveClass('bg-slate-50', 'grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)]');
    expect(toolbar?.children).toHaveLength(3);

    const [left, center, right] = Array.from(toolbar!.children) as HTMLElement[];
    expect(within(left).getByRole('button', { name: '0 Plans' })).toBeInTheDocument();
    expect(within(left).getByRole('button', { name: '1 Task' })).toBeInTheDocument();
    expect(within(center).getByRole('textbox', { name: 'Search' })).toHaveClass('border-0', 'bg-slate-100');
    expect(within(center).getByText('⌘K')).toBeInTheDocument();
    // A page's scope control mounts immediately left of search; with none
    // mounted the slot collapses and the column is search alone.
    const scopeSlot = within(center).getByTestId('header-scope-slot');
    expect(center.firstElementChild).toBe(scopeSlot);
    expect(scopeSlot).toBeEmptyDOMElement();
    expect(scopeSlot).toHaveClass('hidden', 'lg:flex', 'lg:empty:hidden');
    expect(within(right).getByRole('button', { name: 'Quick add to-do' })).toBeInTheDocument();
    expect(within(right).getByRole('button', { name: 'New Task' })).toHaveClass('border-0', 'bg-teal-600');
    expect(within(right).getByRole('button', { name: 'System Status' })).toBeInTheDocument();
    expect(within(toolbar!).queryByText('The Octocat')).not.toBeInTheDocument();
    expect(within(toolbar!).queryByRole('button', { name: 'Logout' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Inbox' })).not.toBeInTheDocument();
  });
});
