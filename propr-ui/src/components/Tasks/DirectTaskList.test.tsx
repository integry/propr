import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DirectTaskList from './DirectTaskList';
import * as goalsApi from '../../api/goals';

vi.mock('../../api/goals', () => ({ listGoals: vi.fn() }));

const task = (id: string, overrides: Partial<goalsApi.Goal> = {}) => ({
  id, kind: 'task', title: `Task ${id}`, repository: 'acme/web', desiredState: 'running', resultState: null,
  finalPr: null, updatedAt: new Date().toISOString(),
  liveSummary: { currentTask: 'Running tests', todos: [], tokenUsage: null, nativeGoal: null },
  ...overrides,
}) as goalsApi.Goal;

describe('DirectTaskList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when there are no direct tasks', async () => {
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [] });
    const { container } = render(<MemoryRouter><DirectTaskList /></MemoryRouter>);
    await vi.waitFor(() => expect(goalsApi.listGoals).toHaveBeenCalledWith('task'));
    expect(container).toBeEmptyDOMElement();
  });

  it('lists direct tasks under Tasks with their state and pull request', async () => {
    vi.mocked(goalsApi.listGoals).mockResolvedValue({ goals: [
      task('a'),
      task('b', { desiredState: 'running', resultState: 'completed', finalPr: { number: 42, url: 'https://github.com/acme/web/pull/42' } }),
      task('c'), task('d'),
    ] });
    render(<MemoryRouter><DirectTaskList /></MemoryRouter>);

    const list = await screen.findByRole('list', { name: 'Direct tasks' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByRole('link', { name: /Task a/ })).toHaveAttribute('href', '/tasks/run/a');
    expect(within(list).getByRole('link', { name: '#42' })).toHaveAttribute('href', 'https://github.com/acme/web/pull/42');
    expect(within(list).getByText('completed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New task' })).toHaveAttribute('href', '/tasks/new');

    fireEvent.click(screen.getByRole('button', { name: 'Show all 4 direct tasks' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  });
});
