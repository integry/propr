import React from 'react';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SetupWizard from './SetupWizard';
import { getDraft } from '../../api/proprApi';

const mockGetDraft = vi.mocked(getDraft);

vi.mock('../../api/proprApi', () => ({
  getDraft: vi.fn(),
  createDraft: vi.fn(),
}));

vi.mock('../../hooks/usePlannerSettings', () => ({
  getPlannerSettings: () => ({
    lastGranularity: 'medium',
    lastContextLevel: 50,
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
  SetupWizardLeftPane: () => <div>left pane</div>,
}));

vi.mock('./SetupWizardRightPane', () => ({
  SetupWizardRightPane: () => <div>right pane</div>,
}));

vi.mock('./setupWizardHooks', () => ({
  useRepositoryLoader: () => ({
    repos: [{ name: 'integry/propr', enabled: true }],
    selectedRepo: 'integry/propr',
    setSelectedRepo: vi.fn(),
    reposLoading: false,
    loadError: null,
  }),
  useBranchesLoader: () => ({
    isLoading: false,
    branches: ['main'],
    error: null,
  }),
  useRepoInfoLoader: () => ({
    isLoading: false,
    branches: ['main'],
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
  }),
  usePromptPersistence: vi.fn(),
  computeIsGenerateDisabled: () => false,
  computeCanExport: () => false,
  useAutoResize: () => vi.fn(),
}));

vi.mock('../../hooks/useGenerationPolling', () => ({
  useGenerationPolling: () => ({
    isGenerating: false,
    generationTrace: undefined,
    generationError: null,
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    setGenerationError: vi.fn(),
  }),
}));

describe('SetupWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
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
});
