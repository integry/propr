import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDrafts } from '../api/plannerApi';
import { getInstanceCatalog, getTasks } from '../api/proprApi';
import GlobalSearch from './GlobalSearch';

vi.mock('../api/plannerApi', () => ({ getDrafts: vi.fn() }));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn(), getTasks: vi.fn() }));

const LONG_PLAN_TITLE = 'Sequential MCP Epic Execution and Observability across every connected client';

const Location = () => {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname}{search}</div>;
};

async function renderWithResults() {
  render(
    <MemoryRouter>
      <GlobalSearch />
      <Routes><Route path="*" element={<Location />} /></Routes>
    </MemoryRouter>,
  );
  const input = screen.getByRole('combobox', { name: 'Search' });
  fireEvent.change(input, { target: { value: 'mcp' } });
  await screen.findByRole('listbox', {}, { timeout: 2000 });
  return input;
}

describe('GlobalSearch palette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      agents: [],
      repositories: [{ name: 'integry/mcptest', enabled: true, baseBranch: 'main' }],
    } as never);
    vi.mocked(getDrafts).mockResolvedValue({
      drafts: [{
        draft_id: 'plan-1', repository: 'integry/propr', name: LONG_PLAN_TITLE,
        initial_prompt: 'Run epics in order', status: 'review',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
      total: 1, page: 1, limit: 5, hasMore: false,
    });
    vi.mocked(getTasks).mockResolvedValue({
      tasks: [{
        id: 'task-1', repository: 'integry/propr', title: 'Add MCP connect contract reference',
        status: 'completed', createdAt: new Date().toISOString(), prNumber: 2480, model: 'gpt-6-astra', score: 9,
      }],
      total: 1,
    } as never);
  });

  it('shows full titles in one linear list grouped by type, with a live preview', async () => {
    await renderWithResults();
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    expect(within(list).getByText(LONG_PLAN_TITLE)).not.toHaveClass('truncate');
    expect(within(list).getByText('Repositories')).toBeInTheDocument();
    expect(within(screen.getByTestId('global-search-preview')).getByRole('heading')).toHaveTextContent('integry/mcptest');
    expect(screen.getByTestId('global-search-palette')).toHaveClass('w-[640px]', 'max-h-[70vh]');
  });

  it('walks the list with arrow keys, updating the preview, and opens the highlighted item on Enter', async () => {
    const input = await renderWithResults();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const preview = screen.getByTestId('global-search-preview');
    expect(within(preview).getByRole('heading')).toHaveTextContent('Add MCP connect contract reference');
    expect(within(preview).getByText('PR #2480')).toBeInTheDocument();
    expect(within(preview).getByText('GPT-6 Astra')).toBeInTheDocument();
    expect(within(preview).queryByText('gpt-6-astra')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-activedescendant', 'global-search-option-task_task-1');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/task-1');
  });

  it('shows fresh plan and task timestamps as "just now", never "just now ago"', async () => {
    const input = await renderWithResults();
    const preview = () => screen.getByTestId('global-search-preview');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(within(preview()).getByText('Updated').nextSibling).toHaveTextContent(/^just now$/);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(within(preview()).getByText('Created').nextSibling).toHaveTextContent(/^just now$/);
  });

  it.each([
    ['MacIntel', '⌘↵'],
    ['Win32', 'Ctrl+↵'],
    ['Linux x86_64', 'Ctrl+↵'],
  ])('advertises the GitHub shortcut with the %s modifier', async (platform, label) => {
    const spy = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform);
    try {
      await renderWithResults();
      const palette = screen.getByTestId('global-search-palette');
      expect(within(palette).getAllByText(label).length).toBeGreaterThanOrEqual(2);
      expect(within(palette).queryByText(label === '⌘↵' ? 'Ctrl+↵' : '⌘↵')).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('cycles category scopes with Tab and filters the list', async () => {
    const input = await renderWithResults();
    expect(screen.getByRole('tab', { name: /All \(3\)/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('tab', { name: /Repos \(1\)/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('tab', { name: /Plans \(1\)/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('tab', { name: /All \(3\)/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the highlighted task on GitHub with Cmd+Enter', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const input = await renderWithResults();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(open).toHaveBeenCalledWith('https://github.com/integry/propr/pull/2480', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('previews a plan with its objective, the owner-stripped repo, and a status pill', async () => {
    const input = await renderWithResults();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const preview = screen.getByTestId('global-search-preview');
    expect(within(preview).getByTestId('global-search-description')).toHaveTextContent('Run epics in order');
    expect(within(preview).getByTestId('repository-chip')).toHaveTextContent(/^propr$/);
    expect(within(within(preview).getByTestId('repository-chip')).getByTestId('repository-chip-icon')).toBeInTheDocument();
    expect(within(preview).getByText('Review')).toHaveClass('rounded-full');
  });

  it('caps and truncates a long repository name in the result row, keeping the full slug in a tooltip', async () => {
    const longRepo = `integry/${'A'.repeat(90)}`;
    vi.mocked(getTasks).mockResolvedValue({
      tasks: [{ id: 'task-3', repository: longRepo, title: 'Long repo task', status: 'completed', createdAt: new Date().toISOString() }],
      total: 1,
    } as never);
    vi.mocked(getDrafts).mockResolvedValue({
      drafts: [{
        draft_id: 'plan-3', repository: longRepo, name: 'Long repo plan', initial_prompt: '', status: 'review',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
      total: 1, page: 1, limit: 5, hasMore: false,
    });
    await renderWithResults();
    const metas = within(screen.getByRole('listbox')).getAllByTestId('global-search-result-meta');
    expect(metas).toHaveLength(2);
    for (const meta of metas) {
      expect(meta).toHaveClass('min-w-0', 'max-w-[40%]');
      expect(meta).not.toHaveClass('flex-shrink-0');
      const name = within(meta).getByText('A'.repeat(90));
      expect(name).toHaveClass('truncate');
      expect(name).toHaveAttribute('title', longRepo);
    }
  });

  it('shows a failure reason as a finding with the file path as code', async () => {
    vi.mocked(getTasks).mockResolvedValue({
      tasks: [{
        id: 'task-2', repository: 'integry/propr', title: 'Expose Live Agent Activity over MCP', status: 'failed',
        createdAt: new Date().toISOString(), failedReason: 'Lint failed on src/mcp/activity.ts',
        subtitle: 'Expose Live Agent Activity over MCP',
      }],
      total: 1,
    } as never);
    const input = await renderWithResults();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const preview = screen.getByTestId('global-search-preview');
    expect(within(preview).getByText('Failed', { selector: 'span.rounded-full' })).toBeInTheDocument();
    expect(within(within(preview).getByTestId('global-search-failure')).getByText('src/mcp/activity.ts').tagName).toBe('CODE');
    // A subtitle that only restates the title is not printed again.
    expect(within(preview).queryByTestId('global-search-description')).not.toBeInTheDocument();
  });

  it('closes when the backdrop is clicked', async () => {
    await renderWithResults();
    fireEvent.mouseDown(screen.getByTestId('global-search-backdrop'));
    expect(screen.queryByTestId('global-search-palette')).not.toBeInTheDocument();
  });

  it('labels the footer link for the active scope', async () => {
    const input = await renderWithResults();
    expect(screen.getByRole('button', { name: 'Search all tasks for "mcp" →' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Search all plans for "mcp" →' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.click(screen.getByRole('button', { name: 'Search all tasks for "mcp" →' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks?search=mcp');
  });

  it('keeps a full plan search reachable from the All scope', async () => {
    await renderWithResults();
    fireEvent.click(screen.getByRole('button', { name: 'Search all plans for "mcp" →' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/plans?search=mcp');
  });

  it('runs the active scope\'s full search with Shift+Enter', async () => {
    const input = await renderWithResults();
    expect(screen.getByRole('button', { name: 'Search all tasks for "mcp" →' })).toHaveAttribute('aria-keyshortcuts', 'Shift+Enter');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks?search=mcp');
  });

  it('opens the full plan search with Shift+Enter in the Plans scope', async () => {
    const input = await renderWithResults();
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByTestId('location')).toHaveTextContent('/plans?search=mcp');
  });

  it('hangs the palette left-aligned under the search input', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 200, right: 648, top: 10, bottom: 46, width: 448, height: 36, x: 200, y: 10, toJSON: () => ({}) } as DOMRect,
    );
    await renderWithResults();
    const palette = screen.getByTestId('global-search-palette');
    expect(palette.style.left).toBe('200px');
    expect(palette.style.top).toBe('54px');
    expect(palette).not.toHaveClass('-translate-x-1/2');
    rect.mockRestore();
  });
});
