import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDrafts } from '../api/plannerApi';
import { getInstanceCatalog, getTasks } from '../api/proprApi';
import GlobalSearch from './GlobalSearch';

vi.mock('../api/plannerApi', () => ({ getDrafts: vi.fn() }));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn(), getTasks: vi.fn() }));

const LONG_PLAN_TITLE = 'Sequential MCP Epic Execution and Observability across every connected client';

const Location = () => <div data-testid="location">{useLocation().pathname}</div>;

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
    expect(within(preview).getByText('gpt-6-astra')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-activedescendant', 'global-search-option-task_task-1');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/task-1');
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
});
