import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../api/proprTypes';
import type { HeaderStats } from '../hooks/useHeaderStats';
import MobileBottomNavigation from './MobileBottomNavigation';

const user: CurrentUser = {
  id: 'user-1',
  login: 'octocat',
  username: 'octocat',
  displayName: 'The Octocat',
  email: 'octocat@example.com',
  avatarUrl: null,
  role: 'admin',
  permissions: ['instance.manage_agents'],
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

function renderNavigation(initialEntry = '/tasks/task-1', onLogout = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <MobileBottomNavigation
        user={user}
        onLogout={onLogout}
        isDemoMode={false}
        unreadCount={7}
        systemHealth={systemHealth}
      />
      <Location />
    </MemoryRouter>
  );
  return { onLogout };
}

describe('MobileBottomNavigation', () => {
  it('renders all five destinations in order with the unread count and route active state', () => {
    renderNavigation();

    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    const destinations = within(navigation).getAllByText(/^(Inbox|Activity|New Plan|Repositories|More)$/);

    expect(destinations.map(destination => destination.textContent)).toEqual([
      'Inbox',
      'Activity',
      'New Plan',
      'Repositories',
      'More',
    ]);
    expect(within(navigation).getByText('7')).toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: /Activity/ })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('link', { name: /Inbox/ })).not.toHaveAttribute('aria-current');
  });

  it('opens an accessible More sheet and restores focus after Escape and backdrop close', () => {
    renderNavigation();
    const moreButton = screen.getByRole('button', { name: 'More' });

    fireEvent.click(moreButton);

    const dialog = screen.getByRole('dialog', { name: 'More' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Plans' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Coding Agents' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Logs' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
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

  it('signs out from the identity section', () => {
    const { onLogout } = renderNavigation();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(onLogout).toHaveBeenCalledOnce();
  });
});
