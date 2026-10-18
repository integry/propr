import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTodo, getCategories, type RepoTodoCategory } from '../api/repoTodosApi';
import { fetchEnabledRepos } from '../utils/repoHelpers';
import { savePlannerSettings } from '../hooks/usePlannerSettings';
import BottomSheet from './MobileBottomSheet';
import QuickAddTodo from './QuickAddTodo';

vi.mock('../api/repoTodosApi', () => ({ createTodo: vi.fn(), getCategories: vi.fn() }));
vi.mock('../utils/repoHelpers', () => ({ fetchEnabledRepos: vi.fn() }));

const repos = ['acme/alpha', 'acme/beta', 'acme/gamma'].map(name => ({ name, enabled: true }));
const categories: RepoTodoCategory[] = [{
  categoryId: 'bugs', name: 'Bugs', orderIndex: 0, createdAt: '', updatedAt: '',
}];

async function openForm(layout: 'popover' | 'inline' = 'popover') {
  render(<MemoryRouter initialEntries={['/summaries/acme/alpha']}><QuickAddTodo layout={layout} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: layout === 'inline' ? 'New To-do' : 'Quick add to-do' }));
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
    isCompleted: false, linkedDraftId: null, linkedIssueRepository: null, linkedIssueNumber: null, linkedTaskId: null, createdAt: '', updatedAt: '',
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
    if (layout === 'inline') {
      // The inline form follows its containing sheet, so a press outside it
      // (on the sheet's own controls) leaves it in place; its trigger closes it.
      expect(screen.getByText('To-Do added')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'New To-do' }));
    }
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

describe('Escape in the toolbar popover', () => {
  const trigger = () => screen.getByRole('button', { name: 'Quick add to-do' });

  it('dismisses the popover opened from its trigger, discards the draft and refocuses the trigger', async () => {
    await openForm();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Unsent idea' } });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(createTodo).not.toHaveBeenCalled();
    fireEvent.click(trigger());
    expect(await screen.findByRole('textbox')).toHaveValue('');
  });

  it('dismisses the popover opened by the native New To-do shortcut', async () => {
    // Like GlobalHeader, the parent clears its request once it is handled.
    const Header = () => {
      const [requested, setRequested] = useState(true);
      return <QuickAddTodo externalOpen={requested} onExternalOpenHandled={() => setRequested(false)} />;
    };
    render(<MemoryRouter><Header /></MemoryRouter>);
    const textarea = await screen.findByRole('textbox');
    expect(textarea).toHaveFocus();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(createTodo).not.toHaveBeenCalled();
  });

  it('dismisses with nothing focused, but ignores Escape from controls outside it', async () => {
    render(<MemoryRouter><button type="button">Elsewhere</button><QuickAddTodo /></MemoryRouter>);
    fireEvent.click(trigger());
    await screen.findByRole('textbox');
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: 'Escape' });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('closes the success confirmation too', async () => {
    await openForm();
    await submitTodo();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add another' }), { key: 'Escape' });
    expect(screen.queryByText('To-Do added')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(createTodo).toHaveBeenCalledTimes(1);
  });

  it('leaves the popover open when the repository filter handles Escape', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'acme/beta' }));
    const filter = screen.getByPlaceholderText('Filter repositories...');
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Filter repositories...')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('closes an open category list before the popover', async () => {
    await openForm();
    const categoryToggle = screen.getByRole('button', { name: 'Uncategorized' });
    fireEvent.click(categoryToggle);
    const bugs = screen.getByRole('button', { name: 'Bugs' });
    bugs.focus();
    fireEvent.keyDown(bugs, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Bugs' })).not.toBeInTheDocument();
    expect(categoryToggle).toHaveFocus();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    fireEvent.keyDown(categoryToggle, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('ignores Escape that ends an IME composition', async () => {
    await openForm();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', isComposing: true });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});

it('leaves Escape in the inline form to its containing Create sheet', async () => {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <BottomSheet id="create" title="Create" closeLabel="Close Create menu" onClose={onClose}>
        <QuickAddTodo layout="inline" />
      </BottomSheet>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New To-do' }));
  const textarea = await screen.findByRole('textbox');
  // A nested control's handled Escape reaches neither the form nor the sheet.
  fireEvent.click(await screen.findByRole('button', { name: 'acme/alpha' }));
  fireEvent.keyDown(screen.getByPlaceholderText('Filter repositories...'), { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(textarea, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  // The sheet decides what Escape closes; the form itself stays expanded.
  expect(screen.getByRole('textbox')).toBeInTheDocument();
  expect(createTodo).not.toHaveBeenCalled();
});
