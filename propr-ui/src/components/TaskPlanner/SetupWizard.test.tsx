/* eslint-disable max-lines -- Existing regression matrix is intentionally kept in one file to preserve shared SetupWizard mocks. */
import React from 'react';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SetupWizard from './SetupWizard';
import { getDraft, createDraft, updateDraft, getRepoBranches } from '../../api/proprApi';

const mockGetDraft = vi.mocked(getDraft);
const mockCreateDraft = vi.mocked(createDraft);
const mockUpdateDraft = vi.mocked(updateDraft);
const mockGetRepoBranches = vi.mocked(getRepoBranches);
let lastLeftPaneProps: Record<string, unknown> | undefined;
let mockGenerationPollingState: {
  isGenerating: boolean;
  generationTrace: Record<string, unknown> | undefined;
  generationError: string | null;
} = {
  isGenerating: false,
  generationTrace: undefined,
  generationError: null,
};
const mockNavigate = vi.fn();
let mockLocationState: Record<string, unknown> | undefined;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ state: mockLocationState }),
  };
});

vi.mock('../../api/proprApi', () => ({
  getDraft: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  getRepoBranches: vi.fn(),
}));

vi.mock('../../hooks/usePlannerSettings', () => ({
  getPlannerSettings: () => ({
    lastGranularity: 'medium',
    lastContextLevel: 50,
    lastBaseBranch: null,
  }),
  savePlannerSettings: vi.fn(),
}));

vi.mock('../../hooks/useContextExport', () => ({
  useContextExport: () => ({
    isExporting: false,
    exportContext: vi.fn(),
  }),
}));

vi.mock('../../hooks/useContextRefresh', () => ({
  useContextRefresh: () => ({
    preview: {
      isLoading: true,
      data: null,
      error: null,
      lastSynced: null,
    },
    isContextStale: false,
    timeUntilRefresh: null,
    isPaused: false,
    togglePause: vi.fn(),
    handleManualRefresh: vi.fn(),
    clearCountdown: vi.fn(),
    fetchPreview: vi.fn(),
  }),
}));

vi.mock('../ui/useToast', () => ({
  useToast: () => ({
    addToast: vi.fn(),
  }),
}));

vi.mock('./ComposerControls', () => ({
  GranularityPills: () => <div>granularity</div>,
}));

vi.mock('./GenerationProgress', () => ({
  GenerationProgress: () => <div>generation progress</div>,
}));

vi.mock('./SetupWizardComponents', () => ({
  GenerateButtonContent: () => <span>Generate</span>,
  ModelSelector: () => <div>model selector</div>,
}));

vi.mock('./SetupWizardLeftPane', () => ({
  SetupWizardLeftPane: (props: Record<string, unknown>) => {
    lastLeftPaneProps = props;
    return (
      <div>
        left pane
        {props.isGenerating ? <div>generation progress</div> : null}
      </div>
    );
  },
}));

vi.mock('./SetupWizardRightPane', () => ({
  SetupWizardRightPane: () => <div>right pane</div>,
}));

vi.mock('./setupWizardHooks', () => ({
  useRepositoryLoader: () => ({
    repos: [{ name: 'integry/propr', enabled: true }],
    selectedRepo: 'integry/propr',
    selectedBaseBranch: 'develop',
    setSelectedRepository: vi.fn(),
    reposLoading: false,
    loadError: null,
  }),
  useBranchesLoader: () => ({
    isLoading: false,
    error: null,
  }),
  useRepoInfoLoader: () => ({
    isLoading: false,
    error: null,
  }),
  useAgentsLoader: () => [],
  useIndexedRepositoriesLoader: () => [],
  usePlannerSettingsPersistence: vi.fn(),
  useFileHandling: () => ({
    localFiles: [],
    isUploading: false,
    handlePaste: vi.fn(),
    handleRemoveFile: vi.fn(),
    handleRemoveLocalFile: vi.fn(),
    handleUpload: vi.fn(),
  }),
  useGenerationHandlers: () => ({
    handleGenerateForExistingDraft: vi.fn(),
    handleAbortGeneration: vi.fn(),
  }),
  useDraftCreation: () => vi.fn(),
  useAutoDraftCreation: () => ({
    isAutoCreating: false,
    autoCreateError: null,
    autoCreateWarning: null,
  }),
  useDraftContextConfigSync: vi.fn(),
  useDraftSettingsPersistence: vi.fn(),
  usePreviewTrace: () => undefined,
  useSetupWizardEffects: vi.fn(),
  getBaseBranchPersistenceWarning: (baseBranch?: string) => baseBranch ? `Draft created, but failed to save base branch "${baseBranch}".` : null,
  persistResolvedBaseBranch: (draftId: string, baseBranch?: string) => updateDraft(draftId, {
    context_config: { baseBranch }
  }),
  usePromptPersistence: vi.fn(),
  computeIsGenerateDisabled: () => false,
  computeCanExport: () => false,
  useAutoResize: () => vi.fn(),
}));

vi.mock('../../hooks/useGenerationPolling', () => ({
  useGenerationPolling: () => ({
    isGenerating: mockGenerationPollingState.isGenerating,
    generationTrace: mockGenerationPollingState.generationTrace,
    generationError: mockGenerationPollingState.generationError,
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    setGenerationError: vi.fn(),
  }),
}));

describe('SetupWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    lastLeftPaneProps = undefined;
    mockGenerationPollingState = {
      isGenerating: false,
      generationTrace: undefined,
      generationError: null,
    };
    mockLocationState = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll the draft while gathering context preview', async () => {
    render(
      <MemoryRouter>
        <SetupWizard
          draft={{
            draft_id: 'draft-1',
            repository: 'integry/propr',
            initial_prompt: 'Test prompt',
            status: 'draft',
            attachments: [],
            created_at: '2026-05-06T00:00:00Z',
            generation_trace: {
              steps: [
                { name: 'relevance', status: 'completed' },
                { name: 'context', status: 'in_progress' },
              ],
            },
            context_config: {},
          }}
          onGenerateComplete={vi.fn()}
        />
      </MemoryRouter>
    );

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetDraft).not.toHaveBeenCalled();
  });

  it('anchors edit-mode selector state to the draft branch and persists branch on repo switch', async () => {
    mockCreateDraft.mockResolvedValue({
      draft_id: 'draft-2',
      repository: 'integry/other',
      initial_prompt: 'Test prompt',
      status: 'draft',
      attachments: [],
      created_at: '2026-05-06T00:00:00Z',
    });

    render(
      <MemoryRouter>
        <SetupWizard
          draft={{
            draft_id: 'draft-1',
            repository: 'integry/propr',
            initial_prompt: 'Test prompt',
            status: 'draft',
            attachments: [],
            created_at: '2026-05-06T00:00:00Z',
            context_config: { baseBranch: 'main' },
          }}
          onGenerateComplete={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(lastLeftPaneProps?.selectedBaseBranch).toBe('main');

    await act(async () => {
      await (lastLeftPaneProps?.onRepoChange as ((repo: string, selection?: { baseBranch?: string }) => Promise<void>))(
        'integry/other',
        { repo: 'integry/other', baseBranch: 'develop', option: { name: 'integry/other', enabled: true, baseBranch: 'develop' } }
      );
    });

    expect(mockUpdateDraft).toHaveBeenCalledWith(
      'draft-2',
      expect.objectContaining({ context_config: { baseBranch: 'develop' } })
    );
  });

  it('preserves edit-mode selector state from router state before the draft branch reloads', () => {
    mockLocationState = { initialBaseBranch: 'release' };

    render(
      <MemoryRouter>
        <SetupWizard
          draft={{
            draft_id: 'draft-1',
            repository: 'integry/propr',
            initial_prompt: 'Test prompt',
            status: 'draft',
            attachments: [],
            created_at: '2026-05-06T00:00:00Z',
            context_config: {},
          }}
          onGenerateComplete={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(lastLeftPaneProps?.selectedBaseBranch).toBe('release');
  });

  it('resolves the default branch before switching repos in edit mode when the entry has no baseBranch', async () => {
    mockCreateDraft.mockResolvedValue({
      draft_id: 'draft-2',
      repository: 'integry/other',
      initial_prompt: 'Test prompt',
      status: 'draft',
      attachments: [],
      created_at: '2026-05-06T00:00:00Z',
    });
    mockGetRepoBranches.mockResolvedValue({ defaultBranch: 'release', branches: ['release', 'main'] });

    render(
      <MemoryRouter>
        <SetupWizard
          draft={{
            draft_id: 'draft-1',
            repository: 'integry/propr',
            initial_prompt: 'Test prompt',
            status: 'draft',
            attachments: [],
            created_at: '2026-05-06T00:00:00Z',
            context_config: { baseBranch: 'main' },
          }}
          onGenerateComplete={vi.fn()}
        />
      </MemoryRouter>
    );

    await act(async () => {
      await (lastLeftPaneProps?.onRepoChange as ((repo: string, selection?: { baseBranch?: string }) => Promise<void>))(
        'integry/other',
        { repo: 'integry/other', option: { name: 'integry/other', enabled: true } }
      );
    });

    expect(mockGetRepoBranches).toHaveBeenCalledWith('integry', 'other');
    expect(mockUpdateDraft).toHaveBeenCalledWith(
      'draft-2',
      expect.objectContaining({ context_config: { baseBranch: 'release' } })
    );
  });

  it('preserves todoIds when switching repositories in edit mode', async () => {
    mockLocationState = { todoIds: ['todo-1', 'todo-2'] };
    mockCreateDraft.mockResolvedValue({
      draft_id: 'draft-2',
      repository: 'integry/other',
      initial_prompt: 'Test prompt',
      status: 'draft',
      attachments: [],
      created_at: '2026-05-06T00:00:00Z',
    });

    render(
      <MemoryRouter>
        <SetupWizard
          draft={{
            draft_id: 'draft-1',
            repository: 'integry/propr',
            initial_prompt: 'Test prompt',
            status: 'draft',
            attachments: [],
            created_at: '2026-05-06T00:00:00Z',
            context_config: { baseBranch: 'main' },
          }}
          onGenerateComplete={vi.fn()}
        />
      </MemoryRouter>
    );

    await act(async () => {
      await (lastLeftPaneProps?.onRepoChange as ((repo: string, selection?: { baseBranch?: string }) => Promise<void>))(
        'integry/other',
        { repo: 'integry/other', baseBranch: 'develop', option: { name: 'integry/other', enabled: true, baseBranch: 'develop' } }
      );
    });

    expect(mockCreateDraft).toHaveBeenCalledWith(
      'integry/other',
      'Test prompt',
      { todoIds: ['todo-1', 'todo-2'] }
    );
    expect(mockNavigate).toHaveBeenCalledWith(
      '/studio/draft-2',
      expect.objectContaining({
        replace: true,
        state: expect.objectContaining({ todoIds: ['todo-1', 'todo-2'] })
      })
    );
  });

  it('ignores stale repo switches in edit mode when a newer selection finishes first', async () => {
    let resolveFirstLookup: ((value: { defaultBranch: string; branches: string[] }) => void) | undefined;
    let resolveSecondLookup: ((value: { defaultBranch: string; branches: string[] }) => void) | undefined;

    mockGetRepoBranches
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFirstLookup = resolve;
      }))
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveSecondLookup = resolve;
      }));
    mockCreateDraft.mockResolvedValue({
      draft_id: 'draft-2',
      repository: 'integry/newer',
      initial_prompt: 'Test prompt',
      status: 'draft',
      attachments: [],
      created_at: '2026-05-06T00:00:00Z',
    });

    render(
      <MemoryRouter>
        <SetupWizard
          draft={{
            draft_id: 'draft-1',
            repository: 'integry/propr',
            initial_prompt: 'Test prompt',
            status: 'draft',
            attachments: [],
            created_at: '2026-05-06T00:00:00Z',
            context_config: { baseBranch: 'main' },
          }}
          onGenerateComplete={vi.fn()}
        />
      </MemoryRouter>
    );

    const onRepoChange = lastLeftPaneProps?.onRepoChange as ((repo: string, selection?: { baseBranch?: string }) => Promise<void>);

    const firstChange = onRepoChange(
      'integry/older',
      { repo: 'integry/older', option: { name: 'integry/older', enabled: true } }
    );
    const secondChange = onRepoChange(
      'integry/newer',
      { repo: 'integry/newer', option: { name: 'integry/newer', enabled: true } }
    );

    await act(async () => {
      resolveSecondLookup?.({ defaultBranch: 'develop', branches: ['develop'] });
      await Promise.resolve();
    });
    await act(async () => {
      await secondChange;
    });
    await act(async () => {
      resolveFirstLookup?.({ defaultBranch: 'release', branches: ['release'] });
      await Promise.resolve();
    });
    await act(async () => {
      await firstChange;
    });

    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockCreateDraft).toHaveBeenCalledWith('integry/newer', 'Test prompt', { todoIds: undefined });
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(
      '/studio/draft-2',
      expect.objectContaining({
        state: expect.objectContaining({
          initialRepository: 'integry/newer',
          initialBaseBranch: 'develop'
        })
      })
    );
  });

  it('renders generation progress only once while generating', () => {
    mockGenerationPollingState = {
      isGenerating: true,
      generationTrace: {
        steps: [
          { name: 'relevance', status: 'completed' },
          { name: 'context', status: 'in_progress' },
          { name: 'llm', status: 'pending' },
        ],
      },
      generationError: null,
    };

    const { getAllByText } = render(
      <MemoryRouter>
        <SetupWizard
          draft={{
            draft_id: 'draft-1',
            repository: 'integry/propr',
            initial_prompt: 'Test prompt',
            status: 'generating',
            attachments: [],
            created_at: '2026-05-06T00:00:00Z',
            generation_trace: {
              steps: [
                { name: 'relevance', status: 'completed' },
                { name: 'context', status: 'in_progress' },
              ],
            },
            context_config: {},
          }}
          onGenerateComplete={vi.fn()}
        />
      </MemoryRouter>
    );

    expect(getAllByText('generation progress')).toHaveLength(1);
  });
});
