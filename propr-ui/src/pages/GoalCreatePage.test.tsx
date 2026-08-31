import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoal } from '../api/goalsApi';
import { getInstanceCatalog } from '../api/proprApi';
import GoalCreatePage from './GoalCreatePage';

const mocks = vi.hoisted(() => ({ demoMode: false, addToast: vi.fn() }));

vi.mock('../api/goalsApi', async importOriginal => ({
  ...await importOriginal<typeof import('../api/goalsApi')>(),
  createGoal: vi.fn(),
}));
vi.mock('../api/proprApi', () => ({ getInstanceCatalog: vi.fn() }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: mocks.demoMode }) }));
vi.mock('../components/ui/useToast', () => ({ useToast: () => ({ addToast: mocks.addToast }) }));

const catalog = {
  defaultAgentAlias: 'codex',
  agents: [
    { alias: 'regular', enabled: true, supportedModels: ['regular-model'] },
    { alias: 'disabled-goal', enabled: false, goalCapable: true, supportedModels: ['disabled-model'] },
    {
      alias: 'codex',
      enabled: true,
      goalCapable: true,
      supportedModels: ['not-for-goals', 'goal-model'],
      goalCapableModels: ['goal-model'],
      defaultModel: 'not-for-goals',
    },
  ],
  repositories: [
    { name: 'integry/propr', enabled: true },
    { name: 'integry/disabled', enabled: false },
  ],
};

const Location = () => <output data-testid="location">{useLocation().pathname}</output>;

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/goals/new']}>
      <Routes>
        <Route path="/goals/new" element={<GoalCreatePage />} />
        <Route path="/goals" element={<div>Goals list</div>} />
      </Routes>
      <Location />
    </MemoryRouter>
  );
}

describe('GoalCreatePage', () => {
  beforeEach(() => {
    mocks.demoMode = false;
    mocks.addToast.mockReset();
    vi.mocked(createGoal).mockReset();
    vi.mocked(getInstanceCatalog).mockReset().mockResolvedValue(catalog);
  });

  it('shows loading and filters agents/models through explicit goal capability', async () => {
    renderPage();
    expect(screen.getByRole('status', { name: 'Loading goal catalog' })).toBeInTheDocument();

    const agent = await screen.findByLabelText(/^Agent/);
    expect(within(agent).getAllByRole('option').map(option => option.textContent)).toEqual(['codex']);
    expect(screen.getByLabelText(/^Requested model/)).toHaveValue('goal-model');
    expect(within(screen.getByLabelText(/^Requested model/)).queryByText('not-for-goals')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Repository/)).toHaveValue('integry/propr');
  });

  it('validates accessible fields, concurrency, and both independent Ultrafix values', async () => {
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });
    fireEvent.change(screen.getByLabelText(/^Objective/), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText(/^Maximum concurrent tasks/), { target: { value: '21' } });
    fireEvent.click(screen.getByLabelText('Run Ultrafix after each pull request'));
    fireEvent.change(screen.getByLabelText(/Review goal/), { target: { value: '11' } });
    fireEvent.change(screen.getByLabelText(/Maximum cycles/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));

    expect(await screen.findByText('Objective must be at least 10 characters.')).toHaveAttribute('id', 'goal-objective-error');
    expect(screen.getByLabelText(/^Objective/)).toHaveAttribute('aria-describedby', 'goal-objective-error');
    expect(screen.getByText('Must be between 1 and 20.')).toBeInTheDocument();
    expect(screen.getByText('Review goal must be between 1 and 10.')).toBeInTheDocument();
    expect(screen.getByText('Max cycles must be between 1 and 50.')).toBeInTheDocument();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('submits once per attempt and reuses its idempotency key for retry', async () => {
    let rejectFirst!: (reason: Error) => void;
    const firstAttempt = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    vi.mocked(createGoal)
      .mockReturnValueOnce(firstAttempt)
      .mockResolvedValueOnce({ id: 'goal-1' } as Awaited<ReturnType<typeof createGoal>>);
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });

    fireEvent.change(screen.getByLabelText(/^Objective/), { target: { value: 'Deliver durable goal orchestration' } });
    fireEvent.change(screen.getByLabelText(/^Maximum concurrent tasks/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('radio', { name: /Automatic squash/ }));
    fireEvent.click(screen.getByLabelText('Run Ultrafix after each pull request'));
    fireEvent.change(screen.getByLabelText(/Review goal/), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText(/Maximum cycles/), { target: { value: '12' } });
    const submit = screen.getByRole('button', { name: 'Create Goal' });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(createGoal).toHaveBeenCalledTimes(1));
    const firstKey = vi.mocked(createGoal).mock.calls[0][1];
    expect(vi.mocked(createGoal).mock.calls[0][0]).toMatchObject({
      agent: 'codex',
      model: 'goal-model',
      maxActiveTasks: 5,
      mergePolicy: 'auto_squash',
      ultrafixEnabled: true,
      ultrafixGoal: 9,
      ultrafixMaxCycles: 12,
    });

    rejectFirst(new Error('Temporary failure'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary failure');
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));

    await waitFor(() => expect(createGoal).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createGoal).mock.calls[1][1]).toBe(firstKey);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/goals'));
    expect(mocks.addToast).toHaveBeenCalledWith({ type: 'success', message: 'Goal created successfully.' });
  });

  it('is read-only in demo mode and exposes catalog load errors', async () => {
    mocks.demoMode = true;
    renderPage();
    expect(await screen.findByText(/Goal creation is disabled in demo mode/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Goal' })).toBeDisabled();

    vi.mocked(getInstanceCatalog).mockReset().mockRejectedValue(new Error('Catalog unavailable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Catalog unavailable');
  });

  it('returns to the goals list from the back control', async () => {
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Goals' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/goals');
  });
});
