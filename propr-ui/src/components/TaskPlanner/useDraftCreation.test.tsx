import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraft, generatePlan, updateDraft, uploadAttachment, type PlannerDraft } from '../../api/proprApi';
import { useAutoDraftCreation } from './useAutoDraftCreation';
import { useDraftCreation } from './useDraftCreation';
import { getDraftSetupSnapshot } from './setupWizardPayloads';
import { baseConfig, createDeferred, makeDraft } from './setupWizardHooks.testUtils';
import type { PlannerConfig } from './setupWizardHooks';

vi.mock('../../api/proprApi', () => ({ createDraft: vi.fn(), updateDraft: vi.fn(), uploadAttachment: vi.fn(), generatePlan: vi.fn() }));

const mockCreateDraft = vi.mocked(createDraft);
const mockUpdateDraft = vi.mocked(updateDraft);
const mockUploadAttachment = vi.mocked(uploadAttachment);
const mockGeneratePlan = vi.mocked(generatePlan);

interface HarnessProps { config: PlannerConfig; localFiles: File[] }

// Wires the two hooks exactly as SetupWizard does in new mode.
function renderNewPlan(initialProps: HarnessProps) {
  const navigate = vi.fn();
  const setError = vi.fn();
  const setIsCreating = vi.fn();
  const onDraftCreatedInPlace = vi.fn();
  const onDraftCreated = vi.fn();
  const flushPrompt = vi.fn((draftId: string, prompt: string) => updateDraft(draftId, { initial_prompt: prompt, name: prompt }));
  const hook = renderHook(({ config, localFiles }: HarnessProps) => {
    const autosave = useAutoDraftCreation({
      isNewMode: true, selectedRepo: 'integry/propr', resolvedBaseBranch: config.baseBranch, setupSnapshot: getDraftSetupSnapshot(config),
      prompt: config.prompt, localFiles, onDraftCreated, onDraftCreatedInPlace, navigate, todoIds: ['todo-1'],
    });
    const generate = useDraftCreation({
      selectedRepo: 'integry/propr', config, localFiles, ensureDraftCreated: autosave.ensureDraftCreated,
      uploadPendingLocalFiles: autosave.uploadPendingLocalFiles, flushPrompt, navigate, setError, setIsCreating,
    });
    return { autosave, generate };
  }, { initialProps });
  return { ...hook, navigate, setError, setIsCreating, onDraftCreatedInPlace, onDraftCreated };
}

const config = (overrides: Partial<PlannerConfig> = {}): PlannerConfig => ({ ...baseConfig, prompt: 'Test prompt', baseBranch: 'develop', ...overrides });

describe('useDraftCreation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mockUpdateDraft.mockResolvedValue(undefined as never);
    mockUploadAttachment.mockImplementation(async (_draftId, file) => ({ id: `attachment-${file.name}`, originalName: file.name, tokenEstimate: 1 }));
    mockGeneratePlan.mockResolvedValue({ success: true, status: 'generating', message: 'started', runId: 'run-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the pending autosave and persists exactly one draft for Generate', async () => {
    mockCreateDraft.mockResolvedValue(makeDraft());
    const view = renderNewPlan({ config: config(), localFiles: [] });

    await act(async () => {
      await view.result.current.generate();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockCreateDraft).toHaveBeenCalledWith('integry/propr', 'Test prompt', { todoIds: ['todo-1'] });
    expect(mockUpdateDraft).toHaveBeenCalledTimes(1);
    expect(mockUpdateDraft).toHaveBeenCalledWith('draft-1', { context_config: getDraftSetupSnapshot(config()) });
    expect(mockGeneratePlan).toHaveBeenCalledTimes(1);
    expect(mockGeneratePlan).toHaveBeenCalledWith('draft-1', expect.objectContaining({ baseBranch: 'develop' }));
    expect(view.onDraftCreated).toHaveBeenCalledTimes(1);
    expect(view.navigate).toHaveBeenCalledTimes(1);
    expect(view.navigate).toHaveBeenCalledWith('/studio/draft-1', expect.objectContaining({
      replace: true,
      state: expect.objectContaining({
        initialBaseBranch: 'develop',
        baseBranchPersistenceWarning: null,
        initialDraft: expect.objectContaining({ status: 'generating', context_config: getDraftSetupSnapshot(config()), generation_trace: { steps: [], runId: 'run-1' } }),
      }),
    }));
  });

  it('joins an autosave creation already in flight and keeps changes made while it was pending', async () => {
    const pendingDraft = createDeferred<PlannerDraft>();
    mockCreateDraft.mockReturnValueOnce(pendingDraft.promise);
    const firstFile = new File(['a'], 'first.txt');
    const laterFile = new File(['b'], 'later.txt');
    const view = renderNewPlan({ config: config(), localFiles: [firstFile] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);

    const updatedConfig = config({ prompt: 'Test prompt, refined', generationModel: 'codex:gpt-5.4', manualFiles: ['src/a.ts'] });
    view.rerender({ config: updatedConfig, localFiles: [firstFile, laterFile] });
    let generation!: Promise<void>;
    act(() => {
      generation = view.result.current.generate();
    });
    await act(async () => {
      pendingDraft.resolve(makeDraft());
      await generation;
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockUploadAttachment.mock.calls).toEqual([['draft-1', firstFile], ['draft-1', laterFile]]);
    expect(mockUpdateDraft).toHaveBeenCalledWith('draft-1', { initial_prompt: 'Test prompt, refined', name: 'Test prompt, refined' });
    expect(mockUpdateDraft).toHaveBeenLastCalledWith('draft-1', { context_config: getDraftSetupSnapshot(updatedConfig) });
    expect(mockGeneratePlan).toHaveBeenCalledTimes(1);
    expect(mockGeneratePlan).toHaveBeenCalledWith('draft-1', expect.objectContaining({ generationModel: 'codex:gpt-5.4' }));
    expect(view.navigate).toHaveBeenCalledWith('/studio/draft-1', expect.objectContaining({
      state: expect.objectContaining({
        initialDraft: expect.objectContaining({ initial_prompt: 'Test prompt, refined', context_config: getDraftSetupSnapshot(updatedConfig) }),
      }),
    }));
  });

  it('continues generation when persisting the setup snapshot fails after draft creation', async () => {
    mockCreateDraft.mockResolvedValue(makeDraft());
    mockUpdateDraft.mockRejectedValueOnce(new Error('Transient update failure'));
    const view = renderNewPlan({ config: config(), localFiles: [] });

    await act(async () => {
      await view.result.current.generate();
    });

    expect(view.result.current.autosave.autoCreateWarning).toEqual(expect.stringContaining('failed to save setup settings including base branch "develop"'));
    expect(mockGeneratePlan).toHaveBeenCalledWith('draft-1', expect.objectContaining({ baseBranch: 'develop' }));
    expect(view.setError).not.toHaveBeenCalledWith('Transient update failure');
  });

  it('surfaces a failed creation and lets Generate retry it', async () => {
    mockCreateDraft.mockRejectedValueOnce(new Error('Repository unavailable')).mockResolvedValueOnce(makeDraft());
    const view = renderNewPlan({ config: config(), localFiles: [] });

    await act(async () => {
      await view.result.current.generate();
    });
    expect(view.setError).toHaveBeenLastCalledWith('Failed to create draft');
    expect(view.setIsCreating).toHaveBeenLastCalledWith(false);
    expect(mockGeneratePlan).not.toHaveBeenCalled();

    await act(async () => {
      await view.result.current.generate();
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockCreateDraft).toHaveBeenCalledTimes(2);
    expect(mockGeneratePlan).toHaveBeenCalledTimes(1);
    expect(mockGeneratePlan).toHaveBeenCalledWith('draft-1', expect.anything());
  });

  it('ignores a second Generate while the first is still starting', async () => {
    const pendingDraft = createDeferred<PlannerDraft>();
    mockCreateDraft.mockReturnValueOnce(pendingDraft.promise);
    const view = renderNewPlan({ config: config(), localFiles: [] });

    let first!: Promise<void>;
    act(() => {
      first = view.result.current.generate();
      void view.result.current.generate();
    });
    await act(async () => {
      pendingDraft.resolve(makeDraft());
      await first;
    });

    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockGeneratePlan).toHaveBeenCalledTimes(1);
  });
});
