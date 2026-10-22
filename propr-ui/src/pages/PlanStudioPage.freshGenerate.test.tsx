import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, HashRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftUpdatePayload } from '@propr/shared';
import PlanStudioPage from './PlanStudioPage';
import { ToastContext } from '../components/ui/useToast';
import { createDraft, generatePlan, getDraft, getInstanceCatalog, getRepoBranches, updateDraft, type PlannerDraft } from '../api/proprApi';

// Real page, routing, useDraft and SetupWizard; only the network and socket boundaries are replaced.
vi.mock('../api/proprApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/proprApi')>()),
  getInstanceCatalog: vi.fn(),
  getRepoBranches: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  uploadAttachment: vi.fn(),
  generatePlan: vi.fn(),
  getDraft: vi.fn(),
  previewContext: vi.fn(async () => ({
    success: true, stats: { totalTokens: 1, costEstimate: 0, contextLength: 1, fileCount: 0 }, smartSelection: [], warnings: [],
  })),
}));
vi.mock('../api/repoIndexingApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/repoIndexingApi')>()),
  getRepositoriesIndexingStatus: vi.fn(async () => ({ repositories: [] })),
}));
vi.mock('../api/userRepoPreferencesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/userRepoPreferencesApi')>()),
  getUserRepoPreferences: vi.fn(async () => ({})),
}));
vi.mock('../components/TaskPlanner/PlanEditor', () => ({
  default: ({ draft }: { draft: PlannerDraft }) => <output data-testid="review">{`${draft.draft_id}:${draft.status}`}</output>,
}));
const socket = vi.hoisted(() => {
  const listeners = new Set<(payload: DraftUpdatePayload) => void>();
  return {
    listeners,
    value: {
      socket: null, isConnected: true,
      subscribeToTask: () => {}, unsubscribeFromTask: () => {}, subscribeToDraft: () => {}, unsubscribeFromDraft: () => {},
      subscribeToIndexing: () => {}, unsubscribeFromIndexing: () => {}, subscribeToIndexingUpdates: () => {}, unsubscribeFromIndexingUpdates: () => {},
      onDraftUpdate: (listener: (payload: DraftUpdatePayload) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  };
});
vi.mock('../contexts/useSocket', () => ({ useSocket: () => socket.value, useOptionalSocket: () => socket.value }));

const PROMPT = 'Add a health endpoint';
const toast = { addToast: vi.fn(() => 'toast'), removeToast: vi.fn() };
const renderer = 'propr-app://renderer/renderer.html';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};
const serverDraft = (status: string, runId?: string): PlannerDraft => ({
  draft_id: 'draft-1', repository: 'integry/propr', initial_prompt: PROMPT, status, attachments: [], created_at: '2026-10-22T22:00:00Z',
  ...(runId ? { generation_trace: { runId, steps: [] } } : {}),
  ...(status === 'review' ? { plan_json: [{ id: 'task-1', title: 'Health endpoint', body: 'Body', implementation: 'Impl' }] } : {}),
} as PlannerDraft);
const reconfigureUrl = (url: string) => {
  (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom.reconfigure({ url });
};
const emit = (payload: Partial<DraftUpdatePayload>) => act(() => {
  for (const listener of socket.listeners) listener({ draftId: 'draft-1', timestamp: new Date().toISOString(), ...payload } as DraftUpdatePayload);
});

// Mirrors App.tsx: both studio routes render the same element tree, so the page instance survives /studio/new → /studio/:id.
function renderStudio(desktop: boolean) {
  vi.stubGlobal('__PROPR_DESKTOP__', desktop);
  // Open the studio from the plans list so back/forward has a previous entry to return to.
  reconfigureUrl(desktop ? `${renderer}#/plans` : 'https://app.example/plans');
  window.history.pushState(null, '', desktop ? '#/studio/new' : '/studio/new');
  const Router = desktop ? HashRouter : BrowserRouter;
  return render(
    <ToastContext.Provider value={toast}>
      <Router>
        <Routes>
          <Route path="/studio/new" element={<div><PlanStudioPage isNew /></div>} />
          <Route path="/studio/:draftId" element={<div><PlanStudioPage /></div>} />
          <Route path="/plans" element={<h1>Plans</h1>} />
        </Routes>
      </Router>
    </ToastContext.Provider>
  );
}

const generateButton = () => screen.getByRole('button', { name: /generate/i });
const waitPastAutosaveDebounce = () => act(() => new Promise(resolve => setTimeout(resolve, 1300)));
const historyStep = (step: () => void) => act(async () => {
  const popped = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
  step();
  await popped;
});
const studioUrl = (desktop: boolean) => (desktop ? `${renderer}#/studio/draft-1` : 'https://app.example/studio/draft-1');

async function enterPrompt() {
  const textarea = await screen.findByPlaceholderText(/Describe the feature/);
  await waitFor(() => expect(screen.getByTestId('branch-chip')).toHaveAttribute('data-status', 'resolved'));
  textarea.focus();
  fireEvent.change(textarea, { target: { value: PROMPT } });
  await waitFor(() => expect(generateButton()).toBeEnabled());
  return textarea;
}

describe.each([false, true])('fresh plan generation becomes the displayed draft (desktop=%s)', desktop => {
  beforeEach(() => {
    vi.clearAllMocks();
    socket.listeners.clear();
    localStorage.clear();
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      repositories: [{ name: 'integry/propr', enabled: true, baseBranch: 'main' }], agents: [],
    } as never);
    vi.mocked(getRepoBranches).mockResolvedValue({ defaultBranch: 'main', branches: ['main'] } as never);
    vi.mocked(updateDraft).mockResolvedValue(undefined as never);
    vi.mocked(createDraft).mockImplementation(async (_repo, prompt) => ({ ...serverDraft('draft'), initial_prompt: prompt }));
  });

  afterEach(() => {
    reconfigureUrl('http://localhost:3000/');
    vi.unstubAllGlobals();
  });

  // The server claims the run only after preparing the repository, so the page's own read of the new draft answers
  // with the pre-generation snapshot, usually before the acknowledgement and sometimes after it.
  it.each(['before', 'after'] as const)('shows Generating then Review when Generate races the autosave debounce (stale read %s the acknowledgement)', async staleOrder => {
    const staleFetch = deferred<PlannerDraft>();
    vi.mocked(getDraft).mockImplementationOnce(() => staleFetch.promise).mockResolvedValue(serverDraft('review', 'run-1'));
    const creation = deferred<PlannerDraft>();
    vi.mocked(createDraft).mockImplementationOnce(() => creation.promise);
    const generation = deferred<Awaited<ReturnType<typeof generatePlan>>>();
    vi.mocked(generatePlan).mockImplementationOnce(() => generation.promise);
    renderStudio(desktop);
    const historyLength = window.history.length;
    await enterPrompt();

    fireEvent.click(generateButton());
    await act(async () => creation.resolve(serverDraft('draft')));
    await waitFor(() => expect(generatePlan).toHaveBeenCalledTimes(1));
    expect(window.location.href).toBe(studioUrl(desktop));
    if (staleOrder === 'before') await act(async () => staleFetch.resolve(serverDraft('draft')));
    await act(async () => generation.resolve({ success: true, status: 'generating', message: 'started', runId: 'run-1' }));
    if (staleOrder === 'after') await act(async () => staleFetch.resolve(serverDraft('draft')));

    expect(await screen.findByText('Generating')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Describe the feature/)).not.toBeInTheDocument();
    expect(window.location.href).toBe(studioUrl(desktop));

    // A different run cannot complete this one.
    await emit({ runId: 'run-0', draftStatus: 'review' });
    expect(screen.queryByTestId('review')).not.toBeInTheDocument();
    await emit({ runId: 'run-1', draftStatus: 'review' });
    expect(await screen.findByTestId('review')).toHaveTextContent('draft-1:review');
    await waitPastAutosaveDebounce();
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(generatePlan).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(studioUrl(desktop));

    // /studio/new was replaced, not stacked: back leaves the studio and forward reopens the same plan.
    expect(window.history.length).toBe(historyLength);
    await historyStep(() => window.history.back());
    expect(await screen.findByRole('heading', { name: 'Plans' })).toBeInTheDocument();
    await historyStep(() => window.history.forward());
    expect(await screen.findByTestId('review')).toHaveTextContent('draft-1:review');
    expect(window.location.href).toBe(studioUrl(desktop));
    expect(generatePlan).toHaveBeenCalledTimes(1);
  });

  it('shows Generating then Review when Generate follows an in-place autosave', async () => {
    vi.mocked(getDraft).mockResolvedValueOnce(serverDraft('draft')).mockResolvedValue(serverDraft('review', 'run-1'));
    const generation = deferred<Awaited<ReturnType<typeof generatePlan>>>();
    vi.mocked(generatePlan).mockImplementationOnce(() => generation.promise);
    renderStudio(desktop);
    const textarea = await enterPrompt();
    await waitPastAutosaveDebounce();
    await waitFor(() => expect(window.location.href).toBe(studioUrl(desktop)));
    expect(screen.getByPlaceholderText(/Describe the feature/)).toBe(textarea);
    expect(textarea).toHaveFocus();
    await waitFor(() => expect(generateButton()).toBeEnabled());

    fireEvent.click(generateButton());
    await waitFor(() => expect(generatePlan).toHaveBeenCalledTimes(1));
    await act(async () => generation.resolve({ success: true, status: 'generating', message: 'started', runId: 'run-1' }));

    expect(await screen.findByText('Generating')).toBeInTheDocument();
    await emit({ runId: 'run-1', draftStatus: 'review' });
    expect(await screen.findByTestId('review')).toHaveTextContent('draft-1:review');
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(generatePlan).toHaveBeenCalledTimes(1);
  });

  it('keeps the prompt for a retry when generation fails to start', async () => {
    vi.mocked(getDraft).mockResolvedValue(serverDraft('draft'));
    vi.mocked(generatePlan).mockRejectedValueOnce(new Error('Provider unavailable'));
    renderStudio(desktop);
    await enterPrompt();

    fireEvent.click(generateButton());
    expect(await screen.findByText('Provider unavailable')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Describe the feature/)).toHaveValue(PROMPT);
    expect(screen.queryByText('Generating')).not.toBeInTheDocument();
    expect(createDraft).toHaveBeenCalledTimes(1);
  });
});
