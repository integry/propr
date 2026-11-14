import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SidebarNavigation, type NavigationState } from './SidebarNavigation';

const state: NavigationState = {
  currentPath: '/plugins', desktop: false, hasAgents: true, hasRepos: true, hasTasks: true,
  taskCount: 0, goalCount: 0, generatingPlansCount: 0, unreadCount: null,
};
const renderSidebar = (canManagePlugins?: boolean) => render(
  <MemoryRouter>
    <SidebarNavigation state={state} permissions={{ canManageAgents: false, canManageMembers: false, canReadMcpLog: false, canManagePlugins }} />
  </MemoryRouter>,
);

describe('SidebarNavigation', () => {
  it('links Plugins for administrators who may manage plugins', () => {
    renderSidebar(true);
    expect(screen.getByRole('link', { name: /Plugins/ })).toHaveAttribute('href', '/plugins');
  });

  it('hides Plugins from everyone else', () => {
    renderSidebar(false);
    expect(screen.queryByRole('link', { name: /Plugins/ })).not.toBeInTheDocument();
  });
});
