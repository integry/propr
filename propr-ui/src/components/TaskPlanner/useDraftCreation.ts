import { useCallback, useRef } from 'react';
import { useHistoryEntryOwnership } from '../../hooks/useHistoryEntryOwnership';
import { generatePlan, PlannerDraft } from '../../api/proprApi';
import { getDraftConfigSnapshot, getPersistedDraftSettings, serializePersistedDraftSettings } from './setupWizardDraftConfig';
import { buildGenerationPayload, getDraftSetupSnapshot } from './setupWizardPayloads';
import { constructDraftWithPlan, getDraftSetupPersistenceWarning, persistDraftSetupSnapshot } from './useAutoDraftCreation';
import type { PlannerConfig } from './setupWizardHooks';

export interface DraftCreationParams {
  selectedRepo: string;
  config: PlannerConfig;
  localFiles: File[];
  // Single-flight draft creation shared with autosave and preview: cancels a pending autosave
  // debounce, joins a creation already in flight, or returns the draft it already created.
  ensureDraftCreated: () => Promise<PlannerDraft | null>;
  uploadPendingLocalFiles: (draftId: string, files: File[]) => Promise<void>;
  flushPrompt: (draftId: string, prompt: string) => Promise<void>;
  // Hands the acknowledged run to the page's draft before navigating; the studio instance survives
  // /studio/new → /studio/:id, so router state alone cannot replace the draft it already holds.
  onGenerationStarted?: (runId: string, draftId: string, snapshot?: PlannerDraft) => void;
  navigate: (path: string, options?: { replace?: boolean; state?: unknown }) => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setIsCreating: React.Dispatch<React.SetStateAction<boolean>>;
}

const serializeSettings = (config: PlannerConfig) => serializePersistedDraftSettings(getPersistedDraftSettings(config));

// The draft may have been created from an earlier render (an autosave already in flight); persist anything changed since.
async function syncDraftSetup(draft: PlannerDraft, config: PlannerConfig): Promise<string | null> {
  const persistedSettings = serializeSettings({ ...config, ...(getDraftConfigSnapshot(draft) ?? {}) });
  if (persistedSettings === serializeSettings(config)) return null;
  try {
    await persistDraftSetupSnapshot(draft.draft_id, getDraftSetupSnapshot(config));
    return null;
  } catch (err) {
    console.error('Failed to persist draft setup snapshot:', err);
    return getDraftSetupPersistenceWarning(config.baseBranch);
  }
}

// Generate in new mode: persist the draft through the same creation autosave uses, then start generation for it.
export function useDraftCreation({ selectedRepo, config, localFiles, ensureDraftCreated, uploadPendingLocalFiles, flushPrompt, onGenerationStarted, navigate, setError, setIsCreating }: DraftCreationParams) {
  const isStartingRef = useRef(false);
  const claimHistoryEntry = useHistoryEntryOwnership();
  return useCallback(async () => {
    if (!selectedRepo || !config.prompt.trim()) return void setError('Please select a repository and enter a prompt');
    if (!config.baseBranch) return void setError('Please wait for the repository branch to finish loading');
    if (isStartingRef.current) return;
    isStartingRef.current = true;
    setIsCreating(true);
    setError(null);
    const isStillOnEntry = claimHistoryEntry();
    try {
      const draft = await ensureDraftCreated();
      if (!draft) throw new Error('Failed to create draft');
      const prompt = config.prompt.trim();
      if ((draft.initial_prompt ?? '').trim() !== prompt) await flushPrompt(draft.draft_id, prompt);
      const baseBranchPersistenceWarning = await syncDraftSetup(draft, config);
      await uploadPendingLocalFiles(draft.draft_id, localFiles);
      const generation = await generatePlan(draft.draft_id, buildGenerationPayload(config));
      // After the user left, the run stays on the server and the draft reopens normally; the
      // acknowledgement must not pull them back or replace whatever entry they are on now.
      if (!isStillOnEntry(`/studio/${draft.draft_id}`)) return void setIsCreating(false);
      const draftWithPlan = constructDraftWithPlan({ ...draft, initial_prompt: prompt }, getDraftSetupSnapshot(config));
      draftWithPlan.status = 'generating';
      draftWithPlan.generation_trace = { steps: [], runId: generation.runId };
      onGenerationStarted?.(generation.runId, draft.draft_id, draftWithPlan);
      navigate(`/studio/${draft.draft_id}`, { replace: true, state: { initialDraft: draftWithPlan, initialBaseBranch: config.baseBranch, baseBranchPersistenceWarning } });
    } catch (err) {
      setError((err as Error).message || 'Failed to create draft');
      setIsCreating(false);
    } finally {
      isStartingRef.current = false;
    }
  }, [selectedRepo, config, localFiles, ensureDraftCreated, uploadPendingLocalFiles, flushPrompt, onGenerationStarted, navigate, claimHistoryEntry, setError, setIsCreating]);
}
