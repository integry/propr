import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../api/proprTypes';
import { DesktopContext, type DesktopContextValue } from '../desktop/DesktopContext';
import { DESKTOP_UI_COMMAND_EVENT } from '../desktop/useDesktopNativeCommands';
import GlobalHeader from './GlobalHeader';

vi.mock('../hooks/useHeaderStats', () => ({
  useHeaderStats: () => ({ systemHealth: { isHealthy: true, agents: [] } }),
}));
vi.mock('./GlobalHeaderComponents', () => ({ SystemHealth: () => null }));
vi.mock('./MobileBottomNavigation', () => ({
  default: ({ onSearch }: { onSearch?: () => void }) => (
    <>
      <button type="button">Tasks tab</button>
      <button type="button" onClick={onSearch}>Menu Search</button>
    </>
  ),
}));
vi.mock('./QuickAddTodo', () => ({ default: () => null }));
// A local stand-in for the search hook: real typing state, one task result, no network.
vi.mock('../hooks/useGlobalSearch', () => ({
  useGlobalSearch: () => {
    const [query, setQueryState] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const results = useMemo(() => ({
      plans: [],
      repositories: [],
      tasks: query ? [{ id: 'task-7', title: `Result for ${query}`, status: 'completed', createdAt: '2026-10-19T12:00:00Z' }] : [],
    }), [query]);
    return {
      query, results, isLoading: false, isOpen, error: null, hasResults: results.tasks.length > 0,
      setQuery: (next: string) => { setQueryState(next); setIsOpen(Boolean(next.trim())); },
      clearSearch: () => { setQueryState(''); setIsOpen(false); },
      setIsOpen,
    };
  },
}));

const user: CurrentUser = {
  id: 'user-1', login: 'octocat', username: 'octocat', displayName: 'The Octocat', email: null,
  avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local',
};
const desktop = { isDesktop: true, platform: 'linux' } as DesktopContextValue;

const Location = () => <output aria-label="Location">{useLocation().pathname}</output>;

const renderHeader = (inDesktop = true) => render(
  <DesktopContext.Provider value={inDesktop ? desktop : null}>
    <MemoryRouter initialEntries={['/tasks']}>
      <GlobalHeader user={user} onLogout={vi.fn()} onMenuToggle={vi.fn()} MenuIcon={() => null} />
      <Location />
    </MemoryRouter>
  </DesktopContext.Provider>,
);

/** Dispatches exactly what useDesktopNativeCommands sends for the native Search menu item. */
const sendSearch = () => act(() => {
  window.dispatchEvent(new CustomEvent(DESKTOP_UI_COMMAND_EVENT, { detail: 'search', cancelable: true }));
});

let mediaListeners: Array<() => void> = [];
let wide = true;
const setWide = (next: boolean) => {
  wide = next;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return wide && query === '(min-width: 768px)'; },
    media: query,
    addEventListener: (_: string, listener: () => void) => { mediaListeners.push(listener); },
    removeEventListener: (_: string, listener: () => void) => { mediaListeners = mediaListeners.filter(l => l !== listener); },
  }));
};

const toolbarInput = () => within(document.querySelector<HTMLElement>('header.desktop-content-toolbar')!).getByRole('combobox', { name: 'Search' });

beforeEach(() => {
  mediaListeners = [];
  setWide(true);
});
afterEach(() => vi.unstubAllGlobals());

describe('GlobalHeader native Search command', () => {
  it('focuses the toolbar field at desktop widths, without opening the narrow sheet', () => {
    renderHeader();
    sendSearch();
    expect(toolbarInput()).toHaveFocus();
    expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();
    toolbarInput().blur();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(toolbarInput()).toHaveFocus();
  });

  it('opens a usable search sheet when the toolbar is collapsed (narrow or zoomed window)', () => {
    setWide(false);
    renderHeader();
    const opener = screen.getByRole('button', { name: 'Tasks tab' });
    opener.focus();
    sendSearch();
    const sheet = screen.getByRole('dialog', { name: 'Search' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    // The sheet is its own field, not the toolbar's hidden one.
    const input = within(sheet).getByRole('combobox', { name: 'Search' });
    expect(input).not.toBe(toolbarInput());
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: 'zoom' } });
    expect(within(sheet).getByRole('option', { name: /Result for zoom/ })).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'true');

    // A repeat request keeps the one sheet and refocuses its field.
    input.blur();
    sendSearch();
    expect(screen.getAllByRole('dialog', { name: 'Search' })).toHaveLength(1);
    expect(input).toHaveFocus();

    // Escape dismisses the sheet and returns focus to where the operator was.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(screen.getByLabelText('Location')).toHaveTextContent('/tasks');
  });

  it('opens the same sheet from the mobile menu\'s Search row, without a desktop adapter', () => {
    setWide(false);
    renderHeader(false);
    const menuSearch = screen.getByRole('button', { name: 'Menu Search' });
    menuSearch.focus();
    fireEvent.click(menuSearch);
    const sheet = screen.getByRole('dialog', { name: 'Search' });
    expect(within(sheet).getByRole('combobox', { name: 'Search' })).toHaveFocus();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();
    expect(menuSearch).toHaveFocus();
  });

  it('routes Ctrl/Cmd+K the same way as the native command at narrow widths', () => {
    setWide(false);
    renderHeader(false);
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    const sheet = screen.getByRole('dialog', { name: 'Search' });
    expect(within(sheet).getByRole('combobox', { name: 'Search' })).toHaveFocus();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('opens the chosen result and closes the sheet', () => {
    setWide(false);
    renderHeader();
    sendSearch();
    const sheet = screen.getByRole('dialog', { name: 'Search' });
    const input = within(sheet).getByRole('combobox', { name: 'Search' });
    fireEvent.change(input, { target: { value: 'zoom' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByLabelText('Location')).toHaveTextContent('/tasks/task-7');
    expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('dismisses on a backdrop press and steps aside when the window widens', () => {
    setWide(false);
    renderHeader();
    sendSearch();
    // false: the press is cancelled, so it can't move the restored focus.
    expect(fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Search' }).firstElementChild!)).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();

    sendSearch();
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeInTheDocument();
    wide = true;
    act(() => mediaListeners.forEach(listener => listener()));
    expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('dismisses the whole sheet on one backdrop press while results are shown', () => {
    setWide(false);
    renderHeader();
    const opener = screen.getByRole('button', { name: 'Tasks tab' });
    opener.focus();
    sendSearch();
    const sheet = screen.getByRole('dialog', { name: 'Search' });
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Search' }), { target: { value: 'zoom' } });
    // The palette's backdrop sits above the sheet's own backdrop and takes the press.
    expect(fireEvent.mouseDown(within(sheet).getByTestId('global-search-backdrop'))).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(screen.getByLabelText('Location')).toHaveTextContent('/tasks');
  });

  it('gives the sheet its own listbox and option ids when the toolbar palette stays open after narrowing', () => {
    renderHeader(false);
    fireEvent.change(toolbarInput(), { target: { value: 'zoom' } });
    expect(screen.getByRole('listbox', { name: 'Search results' })).toBeInTheDocument();

    // Narrowing hides the toolbar with CSS; its palette stays mounted and open.
    wide = false;
    act(() => mediaListeners.forEach(listener => listener()));
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const sheet = screen.getByRole('dialog', { name: 'Search' });
    const sheetInput = within(sheet).getByRole('combobox', { name: 'Search' });
    fireEvent.change(sheetInput, { target: { value: 'zoom' } });

    const ids = Array.from(document.querySelectorAll('[id]'), element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(2);
    const listbox = document.getElementById(sheetInput.getAttribute('aria-controls')!);
    const option = document.getElementById(sheetInput.getAttribute('aria-activedescendant')!);
    expect(listbox).toBe(within(sheet).getByRole('listbox', { name: 'Search results' }));
    expect(option).toBe(within(sheet).getByRole('option', { name: /Result for zoom/ }));
    expect(toolbarInput().getAttribute('aria-controls')).not.toBe(sheetInput.getAttribute('aria-controls'));
  });

  it('keeps Tab inside the sheet', () => {
    setWide(false);
    renderHeader();
    sendSearch();
    const sheet = screen.getByRole('dialog', { name: 'Search' });
    const close = within(sheet).getByRole('button', { name: 'Close search' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(within(sheet).getByRole('combobox', { name: 'Search' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
  });
});
