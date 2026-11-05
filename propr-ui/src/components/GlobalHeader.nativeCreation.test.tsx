import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../api/proprTypes';
import { createTodo, getCategories } from '../api/repoTodosApi';
import { DesktopContext, type DesktopContextValue } from '../desktop/DesktopContext';
import { DESKTOP_UI_COMMAND_EVENT } from '../desktop/useDesktopNativeCommands';
import { fetchEnabledRepos } from '../utils/repoHelpers';
import GlobalHeader from './GlobalHeader';

vi.mock('../api/repoTodosApi', () => ({ createTodo: vi.fn(), getCategories: vi.fn() }));
vi.mock('../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn() }));
vi.mock('../hooks/useHeaderStats', () => ({
  useHeaderStats: () => ({ systemHealth: { isHealthy: true, agents: [] } }),
}));
vi.mock('./GlobalSearch', () => ({ default: () => <input aria-label="Search" /> }));
vi.mock('./GlobalHeaderComponents', () => ({ SystemHealth: () => null }));

const user: CurrentUser = {
  id: 'user-1', login: 'octocat', username: 'octocat', displayName: 'The Octocat', email: null,
  avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local',
};
const desktop = { isDesktop: true, platform: 'linux' } as DesktopContextValue;
const CREATION = ['new-task', 'new-plan', 'new-goal', 'new-automation', 'new-todo'] as const;

const Location = () => <output aria-label="Location">{useLocation().pathname}</output>;

const renderHeader = ({ demo = false, inDesktop = true } = {}) => render(
  <DesktopContext.Provider value={inDesktop ? desktop : null}>
    <MemoryRouter initialEntries={['/tasks']}>
      <GlobalHeader user={user} onLogout={vi.fn()} onMenuToggle={vi.fn()} MenuIcon={() => null} isDemoMode={demo} />
      <Location />
    </MemoryRouter>
  </DesktopContext.Provider>,
);

/** Dispatches exactly what useDesktopNativeCommands sends; returns whether it was allowed. */
const send = (command: string): boolean => {
  let allowed = true;
  act(() => {
    allowed = window.dispatchEvent(new CustomEvent(DESKTOP_UI_COMMAND_EVENT, { detail: command, cancelable: true }));
  });
  return allowed;
};

const setWide = (wide: boolean) => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: wide && query === '(min-width: 768px)', media: query }));
};

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(fetchEnabledRepos).mockResolvedValue([{ name: 'acme/alpha', enabled: true }]);
  vi.mocked(getCategories).mockResolvedValue([]);
  setWide(true);
});
afterEach(() => vi.unstubAllGlobals());

describe('GlobalHeader native creation commands', () => {
  it('opens the toolbar quick add for New To-do without creating anything, and cancels cleanly', async () => {
    renderHeader();
    expect(send('new-todo')).toBe(true);
    const field = await screen.findByPlaceholderText('Describe your idea...');
    expect(field).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Add To-Do' })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'Draft idea' } });
    expect(createTodo).not.toHaveBeenCalled();
    // A repeated request while open is consumed rather than queued.
    send('new-todo');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByPlaceholderText('Describe your idea...')).not.toBeInTheDocument();
    await act(async () => undefined);
    expect(screen.queryByPlaceholderText('Describe your idea...')).not.toBeInTheDocument();
    expect(createTodo).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Location')).toHaveTextContent('/tasks');
    // Route-backed creation stays with the native navigator; the header only allows it.
    for (const command of CREATION.slice(0, 4)) expect(send(command)).toBe(true);
    expect(screen.getByLabelText('Location')).toHaveTextContent('/tasks');
  });

  it('refuses every creation command in demo mode, so no form opens', async () => {
    renderHeader({ demo: true });
    for (const command of CREATION) expect(send(command)).toBe(false);
    await act(async () => undefined);
    expect(screen.queryByPlaceholderText('Describe your idea...')).not.toBeInTheDocument();
    expect(send('search')).toBe(true);
  });

  it('opens quick add in the Create sheet when the toolbar is collapsed (narrow or zoomed window)', async () => {
    setWide(false);
    renderHeader();
    send('new-todo');
    const sheet = await screen.findByRole('dialog', { name: 'Create' });
    await waitFor(() => expect(sheet.querySelector('textarea')).not.toBeNull());
    expect(createTodo).not.toHaveBeenCalled();
  });

  it('ignores desktop commands outside the desktop app', () => {
    renderHeader({ inDesktop: false });
    for (const command of CREATION) expect(send(command)).toBe(true);
    expect(screen.queryByPlaceholderText('Describe your idea...')).not.toBeInTheDocument();
  });
});
