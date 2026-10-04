import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TasksPage from './TasksPage';
import { getRepositoryStats, getTasks } from '../api/proprApi';

vi.mock('../api/proprApi', () => ({
  getTasks: vi.fn(),
  getRepositoryStats: vi.fn(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({ isConnected: false, onTaskUpdate: () => () => undefined }),
}));

vi.mock('../components/TaskList/Filters', () => ({
  Filters: ({ searchQuery, setSearchQuery }: { searchQuery: string; setSearchQuery: (value: string) => void }) => (
    <input aria-label="Search tasks" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} />
  ),
}));

// Deletion is held here until a test lets it finish, as a slow request would be.
const deletion = vi.hoisted(() => ({ hold: false, finish: [] as Array<() => void> }));

// Like the real follow-up dialog, the draft lives in the details view and goes when it unmounts.
const FollowupDialog = () => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  if (!open) return <button type="button" onClick={() => setOpen(true)}>Follow up</button>;
  return (
    <div role="dialog" aria-modal="true" aria-label="Follow-up">
      <textarea aria-label="Follow-up request" value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="button">Send follow-up</button>
    </div>
  );
};

// The details view has its own suites; here it only has to say which task it shows and how.
vi.mock('../components/TaskDetails', () => ({
  default: ({ taskId, embedded, onDeleted }: { taskId?: string; embedded?: boolean; onDeleted?: (taskId: string) => void }) => {
    // Like the real view, a delete reports to the callback it had when it started, even after unmounting.
    const deleteTask = () => {
      const finish = () => onDeleted?.(taskId!);
      if (deletion.hold) deletion.finish.push(finish);
      else finish();
    };
    return (
      <div data-testid="task-details" data-embedded={String(Boolean(embedded))}>
        details for {taskId ?? 'route'}
        {embedded && <button type="button" onClick={deleteTask}>Delete task</button>}
        {embedded && <FollowupDialog />}
      </div>
    );
  },
}));

const task = (id: string, prNumber: number, minutes: number) => ({
  id, repository: 'integry/propr', repositoryOwner: 'integry', repositoryName: 'propr',
  prNumber, issueNumber: prNumber, title: `Fix PR #${prNumber}: Change ${id}`, status: 'completed',
  createdAt: new Date(Date.UTC(2026, 9, 1, 12, 60 - minutes)).toISOString(),
});
// Three rows: PR 3 has two runs, so j/k step over its earlier run.
const tasks = [task('a', 1, 1), task('b', 2, 2), task('c', 3, 3), task('c-earlier', 3, 4)];

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
};

const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/tasks/:taskId" element={<TasksPage />} />
    </Routes>
    <LocationProbe />
  </MemoryRouter>,
);

const location = () => new URL(screen.getByTestId('location').textContent!, 'http://propr.test');
const titleLink = (name: string) => within(screen.getByRole('table', { name: 'Tasks' })).getByRole('link', { name });

function mockViewport(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

describe('TasksPage split workspace', () => {
  beforeEach(() => {
    vi.mocked(getTasks).mockResolvedValue({ tasks, total: 4 } as unknown as Awaited<ReturnType<typeof getTasks>>);
    vi.mocked(getRepositoryStats).mockResolvedValue({ repositories: [] } as unknown as Awaited<ReturnType<typeof getRepositoryStats>>);
  });

  afterEach(() => {
    deletion.hold = false;
    deletion.finish.length = 0;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps the list full width until a task is selected', async () => {
    mockViewport(true);
    renderAt('/tasks');
    await screen.findByRole('table', { name: 'Tasks' });
    expect(screen.queryByTestId('task-split-details')).not.toBeInTheDocument();
  });

  it('opens a clicked task beside the list, in the URL, keeping the filters', async () => {
    mockViewport(true);
    renderAt('/tasks?repository=integry%2Fpropr');
    await screen.findByRole('table', { name: 'Tasks' });
    fireEvent.click(titleLink('Change b'), { detail: 1 });
    expect(location().pathname).toBe('/tasks');
    expect(location().searchParams.get('task')).toBe('b');
    expect(location().searchParams.get('repository')).toBe('integry/propr');
    const pane = await screen.findByTestId('task-split-details');
    expect(within(pane).getByTestId('task-details')).toHaveTextContent('details for b');
    expect(within(pane).getByTestId('task-details')).toHaveAttribute('data-embedded', 'true');
    expect(within(pane).getByRole('link', { name: /Open full page/ })).toHaveAttribute('href', '/tasks/b');
  });

  it('restores the selection and the filter from the URL', async () => {
    mockViewport(true);
    renderAt('/tasks?task=c&repository=integry%2Fpropr');
    const pane = await screen.findByTestId('task-split-details');
    expect(within(pane).getByTestId('task-details')).toHaveTextContent('details for c');
    await screen.findByRole('table', { name: 'Tasks' });
    expect(vi.mocked(getTasks)).toHaveBeenCalledWith('all', 100, 0, 'integry/propr', '');
  });

  it('steps through primary rows with j/k and the arrow keys, and closes with Escape', async () => {
    mockViewport(true);
    renderAt('/tasks?task=a');
    await screen.findByRole('table', { name: 'Tasks' });
    fireEvent.keyDown(window, { key: 'j' });
    expect(location().searchParams.get('task')).toBe('b');
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(location().searchParams.get('task')).toBe('c');
    // The earlier run of PR 3 is not a stop, and the last row stays selected.
    fireEvent.keyDown(window, { key: 'j' });
    expect(location().searchParams.get('task')).toBe('c');
    fireEvent.keyDown(window, { key: 'k' });
    expect(location().searchParams.get('task')).toBe('b');
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(location().searchParams.get('task')).toBe('a');
    expect(titleLink('Change a').closest('[role="row"]')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(location().searchParams.has('task')).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('task-split-details')).not.toBeInTheDocument());
  });

  it('leaves keys typed into the search box alone', async () => {
    mockViewport(true);
    renderAt('/tasks?task=a');
    await screen.findByRole('table', { name: 'Tasks' });
    const search = screen.getByRole('textbox', { name: 'Search tasks' });
    fireEvent.keyDown(search, { key: 'j' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(location().searchParams.get('task')).toBe('a');
  });

  it('leaves the selection and an unsent follow-up alone while its dialog is open', async () => {
    mockViewport(true);
    renderAt('/tasks?task=a');
    await screen.findByRole('table', { name: 'Tasks' });
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Follow-up request' }), { target: { value: 'Also cover k' } });
    // Focus leaves the textarea, so the keys reach the page from a dialog button.
    const send = screen.getByRole('button', { name: 'Send follow-up' });
    send.focus();
    for (const key of ['j', 'ArrowDown', 'k', 'ArrowUp', 'Escape']) fireEvent.keyDown(send, { key });

    expect(location().searchParams.get('task')).toBe('a');
    expect(within(screen.getByTestId('task-split-details')).getByTestId('task-details')).toHaveTextContent('details for a');
    expect(screen.getByRole('textbox', { name: 'Follow-up request' })).toHaveValue('Also cover k');
  });

  it('closes the pane and reloads the list after the task is deleted from it', async () => {
    mockViewport(true);
    renderAt('/tasks?task=b');
    await screen.findByRole('table', { name: 'Tasks' });
    const calls = vi.mocked(getTasks).mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    });
    expect(location().pathname).toBe('/tasks');
    expect(location().searchParams.has('task')).toBe(false);
    await waitFor(() => expect(vi.mocked(getTasks).mock.calls.length).toBeGreaterThan(calls));
  });

  it('keeps another task open when a delete started earlier finishes after switching to it', async () => {
    mockViewport(true);
    deletion.hold = true;
    renderAt('/tasks?task=a');
    await screen.findByRole('table', { name: 'Tasks' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(deletion.finish).toHaveLength(1);

    fireEvent.click(titleLink('Change b'), { detail: 1 });
    await waitFor(() => expect(screen.getByTestId('task-details')).toHaveTextContent('details for b'));
    const calls = vi.mocked(getTasks).mock.calls.length;

    await act(async () => { deletion.finish[0](); });
    expect(location().searchParams.get('task')).toBe('b');
    expect(within(screen.getByTestId('task-split-details')).getByTestId('task-details')).toHaveTextContent('details for b');
    // The deleted task still leaves the list.
    await waitFor(() => expect(vi.mocked(getTasks).mock.calls.length).toBeGreaterThan(calls));
  });

  it('navigates to the task page below the split breakpoint', async () => {
    mockViewport(false);
    renderAt('/tasks?task=a');
    await screen.findByRole('table', { name: 'Tasks' });
    expect(screen.queryByTestId('task-split-details')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'j' });
    expect(location().searchParams.get('task')).toBe('a');
    fireEvent.click(titleLink('Change b'), { detail: 1 });
    expect(location().pathname).toBe('/tasks/b');
    expect(await screen.findByTestId('task-details')).toHaveTextContent('details for route');
  });
});
