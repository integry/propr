import React from 'react';
import { render, act, screen, within } from '@testing-library/react';
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
let mockPreviewTrace: Record<string, unknown> | undefined;
const mockNavigate = vi.fn();
let mockLocationState: Record<string, unknown> | undefined;
const baseDraft = { draft_id: 'draft-1', repository: 'integry/propr', initial_prompt: 'Test prompt', status: 'draft', attachments: [], created_at: '2026-05-06T00:00:00Z' };
const createdDraft = { draft_id: 'draft-2', repository: 'integry/other', initial_prompt: 'Test prompt', status: 'draft', attachments: [], created_at: '2026-05-06T00:00:00Z' };
const fullContextConfig = { baseBranch: 'main', granularity: 'large', contextLevel: 75, compress: true, contextRepositories: [{ repository: 'integry/shared', branch: 'release' }], generationModel: 'gpt-5.4', manualFiles: ['src/keep.ts'], excludedFiles: ['src/skip.ts'] };
const renderSetupWizard = (draftOverrides: Record<string, unknown> = {}) => render(<MemoryRouter><SetupWizard draft={{ ...baseDraft, ...draftOverrides }} onGenerateComplete={vi.fn()} /></MemoryRouter>);
const triggerRepoChange = (repo: string, selection?: Record<string, unknown> & { baseBranch?: string }) => (lastLeftPaneProps?.onRepoChange as ((nextRepo: string, nextSelection?: Record<string, unknown> & { baseBranch?: string }) => Promise<void>))(repo, selection);

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
  GenerationProgress: () => <div data-testid="generation-progress">generation progress</div>,
}));

vi.mock('./SetupWizardComponents', () => ({
  GenerateButtonContent: () => <span>Generate</span>,
  ModelSelector: () => <div>model selector</div>,
}));

vi.mock('./SetupWizardLeftPane', async () => {
  const actual = await vi.importActual<typeof import('./SetupWizardLeftPane')>('./SetupWizardLeftPane');
  return {
    SetupWizardLeftPane: (props: Record<string, unknown>) => {
      lastLeftPaneProps = props;
      return (
        <div data-testid="setup-wizard-left-pane">
          <actual.SetupWizardLeftPane {...props} />
        </div>
      );
    },
  };
});

vi.mock('./SetupWizardRightPane', async () => {
  const actual = await vi.importActual<typeof import('./SetupWizardRightPane')>('./SetupWizardRightPane');
  return {
    SetupWizardRightPane: (props: Record<string, unknown>) => (
      <div data-testid="setup-wizard-right-pane">
        <actual.SetupWizardRightPane {...props} />
      </div>
    ),
  };
});

vi.mock('./ManualFileSelector', () => ({
  ManualFileSelector: () => <div>manual file selector</div>,
}));

vi.mock('../RepositorySelector', () => ({
  RepositorySelector: () => <div>repository selector</div>,
}));

vi.mock('./SmartFileSelection', () => ({
  SmartFileSelection: () => <div>smart file selection</div>,
}));

vi.mock('./SkeletonLoader', () => ({
  FileSelectionSkeleton: () => <div>file selection skeleton</div>,
}));

vi.mock('./ContextRepositoriesSection', () => ({
  ContextRepositoriesSection: () => <div>context repositories</div>,
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
  usePreviewTrace: () => mockPreviewTrace,
  useSetupWizardEffects: vi.fn(),
  getDraftSetupSnapshot: (config: Record<string, unknown>) => config,
  constructDraftWithPlan: (draft: Record<string, unknown>, setupSnapshot?: Record<string, unknown>) => ({
    ...draft,
    plan_json: [],
    chat_history: [],
    context_config: setupSnapshot,
  }),
  getDraftSetupPersistenceWarning: (baseBranch?: string) => baseBranch ? `Draft created, but failed to save setup settings including base branch "${baseBranch}".` : null,
  persistDraftSetupSnapshot: (draftId: string, setupSnapshot?: Record<string, unknown>) => updateDraft(draftId, {
    context_config: setupSnapshot
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
    mockPreviewTrace = undefined;
    mockLocationState = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll the draft while gathering context preview', async () => {
    renderSetupWizard({ generation_trace: { steps: [{ name: 'relevance', status: 'completed' }, { name: 'context', status: 'in_progress' }] }, context_config: {} });

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetDraft).not.toHaveBeenCalled();
  });

  it('anchors edit-mode selector state to the draft branch and persists the full setup snapshot on repo switch', async () => {
    mockCreateDraft.mockResolvedValue(createdDraft);
    renderSetupWizard({ context_config: fullContextConfig });

    expect(lastLeftPaneProps?.selectedBaseBranch).toBe('main');

    await act(async () => {
      await triggerRepoChange('integry/other', { repo: 'integry/other', baseBranch: 'develop', option: { name: 'integry/other', enabled: true, baseBranch: 'develop' } });
    });

    expect(mockUpdateDraft).toHaveBeenCalledWith(
      'draft-2',
      expect.objectContaining({
        context_config: { ...fullContextConfig, baseBranch: 'develop' }
      })
    );
    expect(mockNavigate).toHaveBeenCalledWith(
      '/studio/draft-2',
      expect.objectContaining({
        replace: true,
        state: expect.objectContaining({
          initialDraft: expect.objectContaining({
            draft_id: 'draft-2',
            context_config: { ...fullContextConfig, baseBranch: 'develop' }
          }),
          initialRepository: 'integry/other',
          initialBaseBranch: 'develop'
        })
      })
    );
  });

  it('preserves edit-mode selector state from router state before the draft branch reloads', () => {
    mockLocationState = { initialBaseBranch: 'release' };
    renderSetupWizard({ context_config: {} });

    expect(lastLeftPaneProps?.selectedBaseBranch).toBe('release');
  });

  it('resolves the default branch before switching repos in edit mode when the entry has no baseBranch', async () => {
    mockCreateDraft.mockResolvedValue(createdDraft);
    mockGetRepoBranches.mockResolvedValue({ defaultBranch: 'release', branches: ['release', 'main'] });
    renderSetupWizard({ context_config: { baseBranch: 'main' } });

    await act(async () => {
      await triggerRepoChange('integry/other', { repo: 'integry/other', option: { name: 'integry/other', enabled: true } });
    });

    expect(mockGetRepoBranches).toHaveBeenCalledWith('integry', 'other');
    expect(mockUpdateDraft).toHaveBeenCalledWith(
      'draft-2',
      expect.objectContaining({
        context_config: expect.objectContaining({ baseBranch: 'release' })
      })
    );
  });

  it('preserves todoIds when switching repositories in edit mode', async () => {
    mockLocationState = { todoIds: ['todo-1', 'todo-2'] };
    mockCreateDraft.mockResolvedValue(createdDraft);
    renderSetupWizard({ context_config: { baseBranch: 'main' } });

    await act(async () => {
      await triggerRepoChange('integry/other', { repo: 'integry/other', baseBranch: 'develop', option: { name: 'integry/other', enabled: true, baseBranch: 'develop' } });
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
    mockCreateDraft.mockResolvedValue({ ...createdDraft, repository: 'integry/newer' });
    renderSetupWizard({ context_config: { baseBranch: 'main' } });

    const firstChange = triggerRepoChange('integry/older', { repo: 'integry/older', option: { name: 'integry/older', enabled: true } });
    const secondChange = triggerRepoChange('integry/newer', { repo: 'integry/newer', option: { name: 'integry/newer', enabled: true } });

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

  it('renders generation progress only in the left pane while generating', () => {
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

    mockPreviewTrace = {
      steps: [
        { name: 'relevance', status: 'completed' },
        { name: 'context', status: 'in_progress' },
      ],
    };

    render(
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

    const leftPane = within(screen.getByTestId('setup-wizard-left-pane'));
    const rightPane = within(screen.getByTestId('setup-wizard-right-pane'));

    expect(leftPane.getByTestId('generation-progress')).toBeInTheDocument();
    expect(rightPane.queryByTestId('generation-progress')).not.toBeInTheDocument();
    expect(rightPane.queryByText('Analyzing source code and gathering context...')).not.toBeInTheDocument();
    expect(rightPane.queryByText('Analyzing context...')).not.toBeInTheDocument();
    expect(rightPane.getByText('Enter a prompt to see cost estimate')).toBeInTheDocument();
    expect(screen.getAllByTestId('generation-progress')).toHaveLength(1);
  });
});
