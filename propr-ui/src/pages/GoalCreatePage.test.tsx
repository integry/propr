import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCatalogResponse } from '@propr/shared';
import { createGoal, GoalApiError, type GoalRecordV1 } from '../api/goalsApi';
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
    { alias: 'regular', enabled: true, goalCapable: false, supportedModels: ['regular-model'], goalCapableModels: [] },
    // Deliberately malformed legacy entry: missing allowlist must fail closed.
    { alias: 'missing-list', enabled: true, goalCapable: true, supportedModels: ['legacy-model'] },
    { alias: 'empty-list', enabled: true, goalCapable: true, supportedModels: ['empty-model'], goalCapableModels: [] },
    { alias: 'disabled-goal', enabled: false, goalCapable: true, supportedModels: ['disabled-model'], goalCapableModels: ['disabled-model'] },
    {
      alias: 'codex',
      enabled: true,
      goalCapable: true,
      supportedModels: ['not-for-goals', 'goal-model'],
      goalCapableModels: ['goal-model', 'not-in-supported-catalog'],
      defaultModel: 'not-for-goals',
    },
  ],
  repositories: [
    { name: 'integry/propr', enabled: true },
    { name: 'integry/disabled', enabled: false },
  ],
} as unknown as InstanceCatalogResponse;

const createdGoal: GoalRecordV1 = {
  goalId: 'goal-1',
  objective: 'Deliver durable goal orchestration',
  repository: 'integry/propr',
  state: 'queued',
  agent: 'codex',
  requestedModel: 'goal-model',
  effectiveModel: 'goal-model',
  maxActiveTasks: 3,
  mergePolicy: 'manual',
  ultrafixEnabled: false,
  ultrafixGoal: null,
  ultrafixMaxCycles: null,
  version: 0,
  createdAt: '2026-08-31T00:00:00Z',
  updatedAt: '2026-08-31T00:00:00Z',
};

const Location = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

function renderPage(entry = '/goals/new') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/goals/new" element={<GoalCreatePage />} />
        <Route path="/goals" element={<div>Goals list</div>} />
      </Routes>
      <Location />
    </MemoryRouter>
  );
}

const createEntry = (returnTarget: string): string => {
  const query = new URLSearchParams({ returnTo: returnTarget });
  return `/goals/new?${query.toString()}`;
};

const setValidObjective = (value = 'Deliver durable goal orchestration') => {
  fireEvent.change(screen.getByLabelText(/^Objective/), { target: { value } });
};

describe('GoalCreatePage', () => {
  beforeEach(() => {
    mocks.demoMode = false;
    mocks.addToast.mockReset();
    vi.mocked(createGoal).mockReset();
    vi.mocked(getInstanceCatalog).mockReset().mockResolvedValue(catalog);
  });

  it('fails closed for missing/empty capability lists and intersects mixed model allowlists', async () => {
    renderPage();
    expect(screen.getByRole('status', { name: 'Loading goal catalog' })).toBeInTheDocument();
    const agent = await screen.findByLabelText(/^Agent/);
    expect(within(agent).getAllByRole('option').map(option => option.textContent)).toEqual(['codex']);
    expect(screen.getByLabelText(/^Requested model/)).toHaveValue('goal-model');
    expect(within(screen.getByLabelText(/^Requested model/)).getAllByRole('option').map(option => option.textContent)).toEqual(['goal-model']);
    expect(screen.getByLabelText(/^Repository/)).toHaveValue('integry/propr');
  });

  it('treats cleared required numeric inputs as invalid and uses the shared 1–20 cycle bound', async () => {
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });
    setValidObjective('1234567890');
    fireEvent.change(screen.getByLabelText(/^Maximum concurrent tasks/), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Run Ultrafix after each pull request'));
    fireEvent.change(screen.getByLabelText(/Review goal/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Maximum cycles/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));

    expect(await screen.findByText('Must be between 1 and 20.')).toBeInTheDocument();
    expect(screen.getByText('Review goal is required when Ultrafix is enabled.')).toBeInTheDocument();
    expect(screen.getByText('Max cycles is required when Ultrafix is enabled.')).toBeInTheDocument();
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('accepts exact lower/upper bounds and sends nullable disabled Ultrafix values', async () => {
    vi.mocked(createGoal).mockResolvedValue(createdGoal);
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });
    setValidObjective('1234567890');
    fireEvent.change(screen.getByLabelText(/^Maximum concurrent tasks/), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText('Run Ultrafix after each pull request'));
    fireEvent.change(screen.getByLabelText(/Review goal/), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/Maximum cycles/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledWith(expect.objectContaining({
      objective: '1234567890', maxActiveTasks: 1, ultrafixGoal: 1, ultrafixMaxCycles: 20,
    }), expect.any(String)));
  });

  it('exposes and enforces the trimmed 10-character objective boundary', async () => {
    vi.mocked(createGoal).mockResolvedValue(createdGoal);
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });
    const objective = screen.getByLabelText(/^Objective/);
    expect(objective).toHaveAttribute('minlength', '10');
    expect(screen.getByText('Required · 10–4000 characters after trimming')).toBeInTheDocument();

    setValidObjective('  123456789  ');
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    expect(await screen.findByText('Objective must be at least 10 characters after trimming.')).toBeInTheDocument();
    expect(createGoal).not.toHaveBeenCalled();

    setValidObjective('  1234567890  ');
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: '1234567890' }),
      expect.any(String)
    ));
  });

  it('reuses the same idempotency key for an exact uncertain retry', async () => {
    vi.mocked(createGoal)
      .mockRejectedValueOnce(new Error('Connection ended before a response'))
      .mockResolvedValueOnce(createdGoal);
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });
    setValidObjective();
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection ended before a response');
    const firstKey = vi.mocked(createGoal).mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createGoal).mock.calls[1][1]).toBe(firstKey);
  });

  it('rotates the idempotency key when any request field is edited after a failed attempt', async () => {
    vi.mocked(createGoal)
      .mockRejectedValueOnce(new Error('Uncertain result'))
      .mockResolvedValueOnce(createdGoal);
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });
    setValidObjective();
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    await screen.findByText('Uncertain result');
    const firstKey = vi.mocked(createGoal).mock.calls[0][1];
    fireEvent.change(screen.getByLabelText(/^Maximum concurrent tasks/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createGoal).mock.calls[1][1]).not.toBe(firstKey);
    expect(vi.mocked(createGoal).mock.calls[1][0]).toMatchObject({ maxActiveTasks: 5 });
  });

  it('provides a new-intent path after goal_idempotency_conflict', async () => {
    vi.mocked(createGoal)
      .mockRejectedValueOnce(new GoalApiError('goal_idempotency_conflict', 409, 'Payload differs'))
      .mockResolvedValueOnce(createdGoal);
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });
    setValidObjective();
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A new key is ready');
    const conflictKey = vi.mocked(createGoal).mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createGoal).mock.calls[1][1]).not.toBe(conflictKey);
  });

  it('keeps demo mode read-only and explains epic/sub-epic/leaf PR output', async () => {
    mocks.demoMode = true;
    renderPage();
    expect(await screen.findByText(/Every completed goal yields an epic pull request/)).toHaveTextContent('optional sub-epic pull requests and leaf issue pull requests');
    expect(screen.getByText(/Goal creation is disabled in demo mode/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Goal' })).toBeDisabled();
  });

  it('uses the refresh-safe canonical return target for Back and Cancel', async () => {
    const returnTarget = '/goals?state=paused&repository=integry%2Fpropr&search=durable+work&cursor=cursor2&cursorHistory=%5Bnull%2C%22cursor1%22%5D';
    const backView = renderPage(createEntry(returnTarget));
    await screen.findByRole('form', { name: 'Create goal' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Goals' }));
    expect(screen.getByTestId('location')).toHaveTextContent(returnTarget);
    backView.unmount();

    renderPage(createEntry(returnTarget));
    await screen.findByRole('form', { name: 'Create goal' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('location')).toHaveTextContent(returnTarget);
  });

  it('returns to the canonical filtered cursor URL after a successful submit', async () => {
    vi.mocked(createGoal).mockResolvedValue(createdGoal);
    const returnTarget = '/goals?state=running&search=orchestration&cursor=cursor2&cursorHistory=%5Bnull%2C%22cursor1%22%5D';
    renderPage(createEntry(returnTarget));
    await screen.findByRole('form', { name: 'Create goal' });
    setValidObjective();
    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(returnTarget));
  });

  it('rejects external and non-goals return targets instead of redirecting away', async () => {
    for (const target of ['https://evil.example/steal', '//evil.example/steal', '/tasks?state=running']) {
      const rendered = render(
        <MemoryRouter initialEntries={[createEntry(target)]}>
          <Routes>
            <Route path="/goals/new" element={<GoalCreatePage />} />
            <Route path="/goals" element={<div>Goals list</div>} />
          </Routes>
          <Location />
        </MemoryRouter>
      );
      await screen.findByRole('form', { name: 'Create goal' });
      fireEvent.click(screen.getByRole('button', { name: 'Back to Goals' }));
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/goals$/);
      rendered.unmount();
    }
  });

  it('exposes catalog errors and a keyboard-labeled back control', async () => {
    vi.mocked(getInstanceCatalog).mockRejectedValue(new Error('Catalog unavailable'));
    const failed = render(
      <MemoryRouter initialEntries={['/goals/new']}>
        <Routes><Route path="/goals/new" element={<GoalCreatePage />} /></Routes>
      </MemoryRouter>
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Catalog unavailable');
    failed.unmount();

    vi.mocked(getInstanceCatalog).mockResolvedValue(catalog);
    renderPage();
    await screen.findByRole('form', { name: 'Create goal' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Goals' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/goals');
  });
});
