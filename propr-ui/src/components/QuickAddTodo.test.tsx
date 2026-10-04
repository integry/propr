import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTodo, getCategories, type RepoTodoCategory } from '../api/repoTodosApi';
import { fetchEnabledRepos } from '../utils/repoHelpers';
import { savePlannerSettings } from '../hooks/usePlannerSettings';
import QuickAddTodo from './QuickAddTodo';

vi.mock('../api/repoTodosApi', () => ({ createTodo: vi.fn(), getCategories: vi.fn() }));
vi.mock('../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn() }));

const repos = ['acme/alpha', 'acme/beta', 'acme/gamma'].map(name => ({ name, enabled: true }));
const categories: RepoTodoCategory[] = [{
  categoryId: 'bugs', name: 'Bugs', orderIndex: 0, createdAt: '', updatedAt: '',
}];

async function openForm(layout: 'popover' | 'inline' = 'popover') {
  render(<MemoryRouter initialEntries={['/summaries/acme/alpha']}><QuickAddTodo layout={layout} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Quick add to-do' }));
  fireEvent.click(await screen.findByRole('button', { name: 'acme/alpha' }));
  fireEvent.click(screen.getByRole('button', { name: 'acme/beta' }));
  await screen.findByRole('button', { name: 'Uncategorized' });
}

async function submitTodo() {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fix invoice dates\nUse the account locale.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Uncategorized' }));
  fireEvent.click(screen.getByRole('button', { name: 'Bugs' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add To-Do' }));
  await screen.findByText('To-Do added');
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(fetchEnabledRepos).mockResolvedValue(repos);
  vi.mocked(getCategories).mockResolvedValue(categories);
  vi.mocked(createTodo).mockResolvedValue({
    todoId: 'todo-1', categoryId: 'bugs', content: 'Fix invoice dates', orderIndex: 0,
    isCompleted: false, linkedDraftId: null, createdAt: '', updatedAt: '',
  });
});

afterEach(() => vi.useRealTimers());

describe.each(['popover', 'inline'] as const)('QuickAddTodo %s', layout => {
  it('keeps the success confirmation and Add another available until dismissed', async () => {
    await openForm(layout);
    expect(screen.queryByRole('button', { name: 'Add another' })).not.toBeInTheDocument();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First idea' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add To-Do' }));
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('To-Do added')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add another' })).toBeVisible();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('To-Do added')).not.toBeInTheDocument();
  });

  it('resets content and category, retains the submitted repository, focuses and submits again', async () => {
    await openForm(layout);
    await submitTodo();
    expect(createTodo).toHaveBeenLastCalledWith({
      repository: 'acme/beta', content: 'Fix invoice dates\nUse the account locale.', categoryId: 'bugs',
    });
    // The submitted repository wins over both URL inference and changed preferences.
    savePlannerSettings({ lastRepository: 'acme/gamma' });
    fireEvent.click(screen.getByRole('button', { name: 'Add another' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('textbox')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Add To-Do' })).toBeDisabled();
    expect(screen.queryByText('To-Do added')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'acme/beta' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Uncategorized' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Bugs' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A new idea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add To-Do' }));
    await screen.findByText('To-Do added');
    expect(createTodo).toHaveBeenLastCalledWith({ repository: 'acme/beta', content: 'A new idea', categoryId: null });
  });
});

it.each([
  { available: [repos[0], repos[2]], preference: 'acme/gamma', expected: 'acme/gamma' },
  { available: [repos[0], repos[2]], preference: 'acme/beta', expected: 'acme/alpha' },
  { available: [repos[2]], preference: 'acme/beta', expected: 'acme/gamma' },
  { available: [], preference: 'acme/beta', expected: null },
])('uses the normal repository fallback: $expected', async ({ available, preference, expected }) => {
  await openForm();
  await submitTodo();
  savePlannerSettings({ lastRepository: preference });
  vi.mocked(fetchEnabledRepos).mockResolvedValue(available);
  fireEvent.click(screen.getByRole('button', { name: 'Add another' }));
  if (expected) {
    await waitFor(() => expect(screen.getByRole('button', { name: expected })).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Another idea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add To-Do' }));
    await screen.findByText('To-Do added');
    expect(createTodo).toHaveBeenLastCalledWith({ repository: expected, content: 'Another idea', categoryId: null });
  } else {
    await screen.findByRole('button', { name: 'No repositories configured' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Another idea' } });
    expect(screen.getByRole('button', { name: 'Add To-Do' })).toBeDisabled();
  }
});

it('ignores a category response from the previous to-do after Add another', async () => {
  await openForm();
  let resolveCategories!: (value: RepoTodoCategory[]) => void;
  vi.mocked(getCategories).mockImplementationOnce(() => new Promise(resolve => { resolveCategories = resolve; }));
  await submitTodo();
  fireEvent.click(screen.getByRole('button', { name: 'Add another' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'acme/beta' })).toBeEnabled());
  await act(async () => resolveCategories(categories));
  expect(screen.getByRole('button', { name: 'Uncategorized' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Bugs' })).not.toBeInTheDocument();
});
