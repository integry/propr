import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SetupWizard from './SetupWizard';
import { ToastContext } from '../ui/useToast';
import { createDraft, generatePlan, getInstanceCatalog, getRepoBranches, updateDraft, uploadAttachment, type PlannerDraft } from '../../api/proprApi';

// Real SetupWizard and planner hooks; only the network boundary is replaced.
vi.mock('../../api/proprApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/proprApi')>()),
  getInstanceCatalog: vi.fn(),
  getRepoBranches: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  uploadAttachment: vi.fn(),
  generatePlan: vi.fn(),
  getDraft: vi.fn(() => new Promise(() => {})),
  previewContext: vi.fn(async () => ({
    success: true, stats: { totalTokens: 1, costEstimate: 0, contextLength: 1, fileCount: 0 }, smartSelection: [], warnings: [],
  })),
}));
vi.mock('../../api/repoIndexingApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/repoIndexingApi')>()),
  getRepositoriesIndexingStatus: vi.fn(async () => ({ repositories: [] })),
}));
vi.mock('../../api/userRepoPreferencesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/userRepoPreferencesApi')>()),
  getUserRepoPreferences: vi.fn(async () => ({})),
}));
vi.mock('../../contexts/useSocket', () => {
  const socket = {
    socket: null, isConnected: false,
    subscribeToTask: () => {}, unsubscribeFromTask: () => {}, subscribeToDraft: () => {}, unsubscribeFromDraft: () => {},
    subscribeToIndexing: () => {}, unsubscribeFromIndexing: () => {}, subscribeToIndexingUpdates: () => {}, unsubscribeFromIndexingUpdates: () => {},
  };
  return { useSocket: () => socket, useOptionalSocket: () => socket };
});

const mockCreateDraft = vi.mocked(createDraft);
const mockUpdateDraft = vi.mocked(updateDraft);
const mockUploadAttachment = vi.mocked(uploadAttachment);
const mockGeneratePlan = vi.mocked(generatePlan);

const PROMPT = 'Add a health endpoint';
const toast = { addToast: vi.fn(() => 'toast'), removeToast: vi.fn() };

const makeDraft = (draftId: string, prompt: string): PlannerDraft => ({
  draft_id: draftId, repository: 'integry/propr', initial_prompt: prompt, status: 'draft', attachments: [], created_at: '2026-10-19T21:35:43Z',
});

// Mirrors PlanStudioPage's /studio/new: an autosaved draft is handed back in place, without navigation.
function NativeNewPlan() {
  const [draft, setDraft] = useState<PlannerDraft>();
  return <SetupWizard draft={draft} onGenerateComplete={() => {}} onDraftCreatedInPlace={setDraft} />;
}

function GeneratingPlan() {
  const { draftId } = useParams();
  const state = useLocation().state as { initialDraft?: PlannerDraft & { context_config?: Record<string, unknown> } };
  return <output data-testid="generating">{`${draftId}:${state?.initialDraft?.status}:${String(state?.initialDraft?.context_config?.generationModel)}`}</output>;
}

function renderNewPlan(initialEntry: string | { pathname: string; state: unknown } = '/studio/new') {
  return render(
    <ToastContext.Provider value={toast}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/studio/new" element={<NativeNewPlan />} />
          <Route path="/studio/:draftId" element={<GeneratingPlan />} />
        </Routes>
      </MemoryRouter>
    </ToastContext.Provider>
  );
}

const generateButton = () => screen.getByRole('button', { name: /generate/i });
const waitPastAutosaveDebounce = () => act(() => new Promise(resolve => setTimeout(resolve, 1300)));

async function enterPrompt(prompt = PROMPT) {
  const textarea = await screen.findByPlaceholderText(/Describe the feature/);
  await waitFor(() => expect(screen.getByTestId('branch-chip')).toHaveAttribute('data-status', 'resolved'));
  fireEvent.change(textarea, { target: { value: prompt } });
  await waitFor(() => expect(generateButton()).toBeEnabled());
}

describe('SetupWizard Generate and autosave share one draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(getInstanceCatalog).mockResolvedValue({
      repositories: [{ name: 'integry/propr', enabled: true, baseBranch: 'main' }],
      agents: [],
    } as never);
    vi.mocked(getRepoBranches).mockResolvedValue({ defaultBranch: 'main', branches: ['main'] } as never);
    let created = 0;
    mockCreateDraft.mockImplementation(async (_repo, prompt) => makeDraft(`draft-${++created}`, prompt));
    mockUpdateDraft.mockResolvedValue(undefined as never);
    mockUploadAttachment.mockImplementation(async (_draftId, file) => ({ id: `attachment-${file.name}`, originalName: file.name, tokenEstimate: 1 }));
    mockGeneratePlan.mockResolvedValue({ success: true, status: 'generating', message: 'started', runId: 'run-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates exactly one draft when Generate is clicked before the autosave debounce fires', async () => {
    renderNewPlan({ pathname: '/studio/new', state: { todoIds: ['todo-1'] } });
    await enterPrompt();
    const attachment = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [attachment] } });
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());

    // As observed natively, POST /generate is still pending when the autosave debounce would fire.
    let startGeneration!: () => void;
    mockGeneratePlan.mockImplementationOnce(() => new Promise(resolve => {
      startGeneration = () => resolve({ success: true, status: 'generating', message: 'started', runId: 'run-1' });
    }));
    fireEvent.click(generateButton());
    await waitFor(() => expect(mockGeneratePlan).toHaveBeenCalledTimes(1));
    await waitPastAutosaveDebounce();
    await act(async () => startGeneration());
    await screen.findByTestId('generating');
    await waitPastAutosaveDebounce();

    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockCreateDraft).toHaveBeenCalledWith('integry/propr', PROMPT, { todoIds: ['todo-1'] });
    expect(mockGeneratePlan).toHaveBeenCalledTimes(1);
    expect(mockGeneratePlan).toHaveBeenCalledWith('draft-1', expect.objectContaining({ baseBranch: 'main' }));
    expect(mockUploadAttachment).toHaveBeenCalledTimes(1);
    expect(mockUploadAttachment).toHaveBeenCalledWith('draft-1', attachment);
    expect(mockUpdateDraft).toHaveBeenCalledWith('draft-1', { context_config: expect.objectContaining({ baseBranch: 'main' }) });
    expect(mockUpdateDraft.mock.calls.every(([draftId]) => draftId === 'draft-1')).toBe(true);
    expect(screen.getByTestId('generating')).toHaveTextContent('draft-1:generating');
  });

  it('generates the in-place autosaved draft without creating another one', async () => {
    renderNewPlan();
    await enterPrompt();
    await waitPastAutosaveDebounce();
    await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(generateButton()).toBeEnabled());

    fireEvent.click(generateButton());
    await waitFor(() => expect(mockGeneratePlan).toHaveBeenCalledTimes(1));

    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockGeneratePlan).toHaveBeenCalledWith('draft-1', expect.objectContaining({ baseBranch: 'main' }));
  });

  it('lets the user retry Generate on the same draft after generation fails to start', async () => {
    mockGeneratePlan.mockRejectedValueOnce(new Error('Provider unavailable'));
    renderNewPlan();
    await enterPrompt();

    fireEvent.click(generateButton());
    expect(await screen.findByText('Provider unavailable')).toBeInTheDocument();
    await waitFor(() => expect(generateButton()).toBeEnabled());
    // The failed attempt already handed the draft back in place, so the retry generates it as an existing draft.
    fireEvent.click(generateButton());
    await waitFor(() => expect(mockGeneratePlan).toHaveBeenCalledTimes(2));
    await waitPastAutosaveDebounce();

    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockGeneratePlan.mock.calls.map(([draftId]) => draftId)).toEqual(['draft-1', 'draft-1']);
  });
});
