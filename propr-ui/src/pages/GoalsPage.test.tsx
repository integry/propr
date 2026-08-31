import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGoalsApiMock, goal, renderPage, resetGoalsPageMocks } from './GoalsPageTestHarness';

const getGoals = getGoalsApiMock();

describe('GoalsPage', () => {
  beforeEach(resetGoalsPageMocks);

  it('uses cursor history for next/previous navigation and never displays an inferred total', async () => {
    vi.mocked(getGoals)
      .mockResolvedValueOnce({ goals: [goal], nextCursor: 'Y3Vyc29yMg' })
      .mockResolvedValue({ goals: [{ ...goal, goalId: 'goal-2' }], nextCursor: null });
    renderPage(['/goals?state=planning']);
    expect(screen.getByText('Loading goals…')).toBeInTheDocument();
    expect(await screen.findByText('Durable orchestration')).toBeInTheDocument();
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'planning', limit: 50, cursor: undefined }), expect.any(Object));

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'Y3Vyc29yMg' }), expect.any(Object)));
    expect(screen.getByTestId('location')).toHaveTextContent('cursor=Y3Vyc29yMg');
    expect(screen.getByRole('navigation', { name: 'Goals pagination' })).toHaveTextContent('Page 2');
    expect(screen.queryByText(/of \d+/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: undefined }), expect.any(Object)));
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursor=');
  });

  it('keeps filters on an empty later page and leaves Previous usable', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [], nextCursor: null });
    renderPage(['/goals?state=paused&repository=integry%2Fpropr&search=durable&cursor=cursor2&cursorHistory=%5Bnull%5D']);

    expect(await screen.findByText('No results for “durable”')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by state')).toHaveValue('paused');
    expect(screen.getByLabelText('Search goals')).toHaveValue('durable');
    const previous = screen.getByRole('button', { name: 'Previous page' });
    expect(previous).toBeEnabled();

    fireEvent.click(previous);
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({
      state: 'paused',
      repository: 'integry/propr',
      search: 'durable',
      cursor: undefined,
    }), expect.any(Object)));
    expect(screen.getByTestId('location')).toHaveTextContent('state=paused');
    expect(screen.getByTestId('location')).toHaveTextContent('repository=integry%2Fpropr');
    expect(screen.getByTestId('location')).toHaveTextContent('search=durable');
  });

  it('stops at the parseable cursor-history boundary and reverses the boundary page', async () => {
    const history = [null, ...Array.from({ length: 98 }, (_, index) => `cursor${index + 1}`)];
    const query = new URLSearchParams({
      cursor: 'cursor99',
      cursorHistory: JSON.stringify(history),
    });
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: 'cursor100' });
    renderPage([`/goals?${query.toString()}`]);

    await screen.findByText('Durable orchestration');
    expect(screen.getByRole('navigation', { name: 'Goals pagination' })).toHaveTextContent('Page 100');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor100' }),
      expect.any(Object)
    ));

    expect(screen.getByRole('navigation', { name: 'Goals pagination' })).toHaveTextContent('Page 101');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    const boundaryUrl = new URL(screen.getByTestId('location').textContent ?? '', 'https://propr.invalid');
    expect(JSON.parse(boundaryUrl.searchParams.get('cursorHistory') ?? '[]')).toHaveLength(100);

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor99' }),
      expect.any(Object)
    ));
    expect(screen.getByRole('navigation', { name: 'Goals pagination' })).toHaveTextContent('Page 100');
  });

  it('provides mobile-visible search and resets cursor history when search changes', async () => {
    vi.useFakeTimers();
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    renderPage(['/goals?cursor=Y3Vyc29y&cursorHistory=%5Bnull%5D']);
    await act(async () => { await Promise.resolve(); });
    const search = screen.getByLabelText('Search goals');
    expect(search.closest('.hidden')).toBeNull();
    fireEvent.change(search, { target: { value: '  operator  ' } });
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('location')).toHaveTextContent('search=operator');
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursor=');
    expect(search).toHaveValue('operator');
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'operator', cursor: undefined }), expect.any(Object));
  });

  it('canonically trims search and bounds astral input by Unicode code points', async () => {
    vi.useFakeTimers();
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    renderPage(['/goals?search=%20%20deep-link%20%20']);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('location')).toHaveTextContent('search=deep-link');
    expect(screen.getByLabelText('Search goals')).toHaveValue('deep-link');
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'deep-link' }), expect.any(Object));

    const search = screen.getByLabelText('Search goals');
    fireEvent.change(search, { target: { value: `  ${'🚀'.repeat(201)}  ` } });
    expect(Array.from((search as HTMLInputElement).value)).toHaveLength(200);
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: '🚀'.repeat(200) }), expect.any(Object));
  });

  it('cleans whitespace-only deep-link search as omitted', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    renderPage(['/goals?search=%20%20%09%20']);
    await screen.findByText('Durable orchestration');
    expect(screen.getByTestId('location')).not.toHaveTextContent('search=');
    expect(screen.getByLabelText('Search goals')).toHaveValue('');
    expect(getGoals).toHaveBeenCalledWith(expect.objectContaining({ search: undefined }), expect.any(Object));
  });

  it('sanitizes invalid legacy page/cursor URL state before requesting', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    renderPage(['/goals?page=NaN&cursor=bad%2Bcursor&cursorHistory=broken']);
    await screen.findByText('Durable orchestration');
    expect(screen.getByTestId('location')).not.toHaveTextContent('page=');
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursor=');
    expect(getGoals).toHaveBeenCalledTimes(1);
    expect(getGoals).toHaveBeenCalledWith(expect.objectContaining({ cursor: undefined }), expect.any(Object));
  });

  it('rejects cursor history with an irreversible null entry', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    const query = new URLSearchParams({ cursor: 'cursor3', cursorHistory: JSON.stringify([null, 'cursor1', null]) });
    renderPage([`/goals?${query.toString()}`]);
    await screen.findByText('Durable orchestration');
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursor=');
    expect(screen.getByTestId('location')).not.toHaveTextContent('cursorHistory=');
    expect(getGoals).toHaveBeenCalledTimes(1);
  });

  it('restores search, filter, and cursor state through browser back/forward navigation', async () => {
    vi.mocked(getGoals).mockResolvedValue({ goals: [goal], nextCursor: null });
    const entries = [
      '/goals?search=first&state=paused',
      '/goals?search=second&state=running&cursor=Y3Vyc29yMg&cursorHistory=%5Bnull%5D',
    ];
    renderPage(entries);
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'second', state: 'running', cursor: 'Y3Vyc29yMg' }), expect.any(Object)));
    expect(screen.getByLabelText('Search goals')).toHaveValue('second');

    fireEvent.click(screen.getByText('Browser back'));
    await waitFor(() => expect(getGoals).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'first', state: 'paused', cursor: undefined }), expect.any(Object)));
    expect(screen.getByLabelText('Search goals')).toHaveValue('first');
    expect(screen.getByLabelText('Filter by state')).toHaveValue('paused');

    fireEvent.click(screen.getByText('Browser forward'));
    await waitFor(() => expect(screen.getByLabelText('Search goals')).toHaveValue('second'));
    expect(screen.getByLabelText('Filter by state')).toHaveValue('running');
  });
});
