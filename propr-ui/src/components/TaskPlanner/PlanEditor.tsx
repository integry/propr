import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsMobile } from '../../hooks/useIsMobile';
import { debounce } from 'lodash';
import { usePlanRefinement } from '../../hooks/usePlanRefinement';
import { DraftWithPlan, finalizePlan, updateDraft, ChatMessage, resetDraftToSetup, abortRefinement, deleteDraft, PlanTask } from '../../api/proprApi';
import { useToast } from '../ui/useToast';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { PlanEditorDesktopLayout } from './PlanEditorDesktopLayout';
import { PlanEditorMobileLayout } from './PlanEditorMobileLayout';
import PlanIntentConfirmationDialog from './PlanIntentConfirmationDialog';
import {
  describePlanPrBehavior,
  type PlanNotificationIntent,
} from '../../utils/notificationIntents';

interface PlanEditorProps {
  draft: DraftWithPlan;
  originalPrompt?: string;
  onFinalize?: () => void;
  onBackToSetup?: () => void;
  notificationIntent?: PlanNotificationIntent | null;
  onNotificationIntentConsumed?: () => void;
}

const noop = () => {};

const getEditableHandler = <T extends (...args: never[]) => unknown>(isReadOnly: boolean, handler: T): T => (
  isReadOnly ? noop as T : handler
);

const parseInitialPlan = (planJson: DraftWithPlan['plan_json'] | string): PlanTask[] => {
  let parsedPlan: unknown = planJson;
  if (typeof parsedPlan === 'string') {
    try { parsedPlan = JSON.parse(parsedPlan); } catch { return []; }
  }
  return Array.isArray(parsedPlan) ? parsedPlan as PlanTask[] : [];
};

const getPlanName = (draft: DraftWithPlan) => draft.name || draft.initial_prompt || 'Untitled Plan';
const getBaseBranch = (draft: DraftWithPlan) => draft.context_config?.baseBranch || 'main';

export const PlanEditor: React.FC<PlanEditorProps> = ({
  draft,
  originalPrompt,
  onFinalize,
  onBackToSetup,
  notificationIntent = null,
  onNotificationIntentConsumed,
}) => {
  const navigate = useNavigate();
  // Keep the dedicated Studio mobile workflow through Tailwind's md boundary.
  const isMobile = useIsMobile(768);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [enforcementNoticeDismissed, setEnforcementNoticeDismissed] = useState(false);
  const [showBackToSetupDialog, setShowBackToSetupDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isResettingToSetup, setIsResettingToSetup] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isChatExpanded, setIsChatExpanded] = useState(false);
  const [focusComposerRequest, setFocusComposerRequest] = useState(0);
  const [showApproveIntentDialog, setShowApproveIntentDialog] = useState(false);
  const { addToast } = useToast();
  const { isDemoMode } = useDemoMode();

  const planName = getPlanName(draft);
  const granularityEnforcement = draft.context_config?.granularityEnforcement;
  const repository = draft.repository;
  const baseBranch = getBaseBranch(draft);
  const initialPlan = parseInitialPlan(draft.plan_json);

  const {
    plan, updateTask, deleteTask, restoreTask, reorderTasks,
    handleRefine, undo, redo, canUndo, canRedo, highlightedIds, refinementProgress
  } = usePlanRefinement(draft.draft_id, initialPlan);

  const handleDeleteTask = useCallback((taskId: string) => {
    if (isDemoMode) {
      addToast({ type: 'warning', message: 'Demo mode is read-only.', duration: 3000 });
      return;
    }
    const deleted = deleteTask(taskId);
    if (deleted) {
      addToast({ type: 'undo', message: `Task "${deleted.task.title}" deleted`, duration: 5000, onUndo: () => restoreTask(deleted) });
    }
  }, [addToast, deleteTask, isDemoMode, restoreTask]);

  const saveChatHistoryRef = useRef(
    debounce(async (draftId: string, messages: ChatMessage[]) => {
      try { await updateDraft(draftId, { chat_history: messages }); } catch (err) { console.error('Failed to save chat history:', err); }
    }, 1000)
  );

  const handleChatMessagesChange = useCallback((messages: ChatMessage[]) => {
    if (isDemoMode) return;
    saveChatHistoryRef.current(draft.draft_id, messages);
  }, [draft.draft_id, isDemoMode]);

  const handleStopRefinement = useCallback(async () => {
    if (isDemoMode) return;
    await abortRefinement(draft.draft_id);
  }, [draft.draft_id, isDemoMode]);

  const handleRefineRequest = useCallback(async (message: string, signal?: AbortSignal, generationModel?: string) => {
    if (isDemoMode) {
      return {
        success: false,
        message: 'Demo mode is read-only. Plan refinement is disabled.',
        cancelled: true,
      };
    }
    return handleRefine(message, signal, generationModel);
  }, [handleRefine, isDemoMode]);

  const handleDeletePlanConfirm = async () => {
    if (isDemoMode) {
      addToast({ type: 'warning', message: 'Demo mode is read-only.', duration: 3000 });
      return;
    }
    setIsDeleting(true);
    try {
      await deleteDraft(draft.draft_id);
      setShowDeleteDialog(false);
      addToast({ type: 'success', message: 'Plan deleted successfully', duration: 3000 });
      navigate('/plans');
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message || 'Failed to delete plan', duration: 5000 });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleFinalize = useCallback(async () => {
    if (isFinalizing || plan.length === 0) return;
    if (isDemoMode) {
      addToast({ type: 'warning', message: 'Demo mode is read-only. GitHub issue creation is disabled.', duration: 4000 });
      return;
    }
    setIsFinalizing(true);
    setFinalizeError(null);
    try {
      const result = await finalizePlan(draft.draft_id);
      if (result.alreadyExecuted) {
        addToast({ type: 'warning', message: 'This plan has already been finalized. No new issues were created.', duration: 5000 });
      }
      onFinalize?.();
    } catch (err) {
      setFinalizeError((err as Error).message || 'Failed to create issues');
    } finally {
      setIsFinalizing(false);
    }
  }, [addToast, draft.draft_id, isDemoMode, isFinalizing, onFinalize, plan.length]);

  useEffect(() => {
    if (!notificationIntent) return;
    if (notificationIntent === 'refine') {
      setIsChatExpanded(true);
      setFocusComposerRequest(request => request + 1);
    } else {
      setShowApproveIntentDialog(true);
    }
    onNotificationIntentConsumed?.();
  }, [notificationIntent, onNotificationIntentConsumed]);

  const approvalDialog = (
    <PlanIntentConfirmationDialog
      isOpen={showApproveIntentDialog}
      mode="approve"
      repository={repository}
      issueCount={plan.length}
      agentModelSelection="Selected after issue creation (no agent starts yet)"
      prBehavior={describePlanPrBehavior(
        draft.context_config?.useEpic,
        draft.context_config?.autoMerge,
      )}
      isLoading={isFinalizing}
      confirmDisabled={plan.length === 0 || isFinalizing}
      readOnly={isDemoMode}
      unavailableReason={plan.length === 0 ? 'The plan must contain at least one issue before it can be approved.' : null}
      onClose={() => { if (!isFinalizing) setShowApproveIntentDialog(false); }}
      onConfirm={() => {
        setShowApproveIntentDialog(false);
        void handleFinalize();
      }}
    />
  );

  const handleBackToSetup = async () => {
    if (isDemoMode) {
      addToast({ type: 'warning', message: 'Demo mode is read-only.', duration: 3000 });
      return;
    }
    setIsResettingToSetup(true);
    try {
      await resetDraftToSetup(draft.draft_id);
      setShowBackToSetupDialog(false);
      onBackToSetup?.();
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message || 'Failed to reset draft', duration: 5000 });
    } finally {
      setIsResettingToSetup(false);
    }
  };

  const canEditUndo = canUndo && !isDemoMode;
  const canEditRedo = canRedo && !isDemoMode;
  const onEditableUndo = getEditableHandler(isDemoMode, undo);
  const onEditableRedo = getEditableHandler(isDemoMode, redo);
  const onEditableTaskChange = getEditableHandler(isDemoMode, updateTask);
  const onEditableReorderTasks = getEditableHandler(isDemoMode, reorderTasks);
  const showDeletePlanDialog = () => { if (!isDemoMode) setShowDeleteDialog(true); };
  const showBackToSetup = () => { if (!isDemoMode) setShowBackToSetupDialog(true); };
  const dismissEnforcementNotice = () => setEnforcementNoticeDismissed(true);

  if (isMobile) {
    return (
      <>
        <PlanEditorMobileLayout
        planName={planName}
        repository={repository}
        baseBranch={baseBranch}
        originalPrompt={originalPrompt}
        isDeleting={isDeleting}
        isFinalizing={isFinalizing}
        isResettingToSetup={isResettingToSetup}
        canUndo={canEditUndo}
        canRedo={canEditRedo}
        finalizeError={finalizeError}
        granularityEnforcement={granularityEnforcement}
        enforcementNoticeDismissed={enforcementNoticeDismissed}
        plan={plan}
        highlightedIds={highlightedIds}
        draftId={draft.draft_id}
        chatHistory={draft.chat_history}
        refinementProgress={refinementProgress}
        defaultModel={draft.context_config?.generationModel ?? null}
        isChatExpanded={isChatExpanded}
        showBackToSetupDialog={showBackToSetupDialog}
        showDeleteDialog={showDeleteDialog}
        onDelete={showDeletePlanDialog}
        onBackToSetup={showBackToSetup}
        onUndo={onEditableUndo}
        onRedo={onEditableRedo}
        onSetEnforcementNoticeDismissed={setEnforcementNoticeDismissed}
        onTaskChange={onEditableTaskChange}
        onDeleteTask={handleDeleteTask}
        onReorderTasks={onEditableReorderTasks}
        onFinalize={handleFinalize}
        onSetChatExpanded={setIsChatExpanded}
        onRefine={handleRefineRequest}
        onChatMessagesChange={handleChatMessagesChange}
        onStopRefinement={handleStopRefinement}
        focusComposerRequest={focusComposerRequest}
        onSetShowBackToSetupDialog={setShowBackToSetupDialog}
        onSetShowDeleteDialog={setShowDeleteDialog}
        onBackToSetupConfirm={handleBackToSetup}
        onDeleteConfirm={handleDeletePlanConfirm}
        isReadOnly={isDemoMode}
        />
        {approvalDialog}
      </>
    );
  }

  return (
    <>
      <PlanEditorDesktopLayout
      planName={planName}
      repository={repository}
      baseBranch={baseBranch}
      originalPrompt={originalPrompt}
      isDeleting={isDeleting}
      isFinalizing={isFinalizing}
      isResettingToSetup={isResettingToSetup}
      canUndo={canEditUndo}
      canRedo={canEditRedo}
      finalizeError={finalizeError}
      granularityEnforcement={granularityEnforcement}
      enforcementNoticeDismissed={enforcementNoticeDismissed}
      plan={plan}
      highlightedIds={highlightedIds}
      draftId={draft.draft_id}
      chatHistory={draft.chat_history}
      refinementProgress={refinementProgress}
      defaultModel={draft.context_config?.generationModel ?? null}
      showBackToSetupDialog={showBackToSetupDialog}
      showDeleteDialog={showDeleteDialog}
      onDelete={showDeletePlanDialog}
      onBackToSetup={showBackToSetup}
      onUndo={onEditableUndo}
      onRedo={onEditableRedo}
      onDismissEnforcementNotice={dismissEnforcementNotice}
      onTaskChange={onEditableTaskChange}
      onDeleteTask={handleDeleteTask}
      onReorderTasks={onEditableReorderTasks}
      onFinalize={handleFinalize}
      onRefine={handleRefineRequest}
      onChatMessagesChange={handleChatMessagesChange}
      onStopRefinement={handleStopRefinement}
      focusComposerRequest={focusComposerRequest}
      onSetShowBackToSetupDialog={setShowBackToSetupDialog}
      onSetShowDeleteDialog={setShowDeleteDialog}
      onBackToSetupConfirm={handleBackToSetup}
      onDeleteConfirm={handleDeletePlanConfirm}
      isReadOnly={isDemoMode}
      />
      {approvalDialog}
    </>
  );
};

export default PlanEditor;
