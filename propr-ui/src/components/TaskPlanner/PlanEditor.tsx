import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Loader2, AlertCircle, GripVertical, Github } from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { debounce } from 'lodash';
import { usePlanRefinement } from '../../hooks/usePlanRefinement';
import { DraftWithPlan, finalizePlan, updateDraft, ChatMessage, resetDraftToSetup, abortRefinement, deleteDraft } from '../../api/proprApi';
import TaskCardList from './TaskCardList';
import RefinementChat from './RefinementChat';
import BackToSetupDialog from './BackToSetupDialog';
import DeletePlanDialog from './DeletePlanDialog';
import { useToast } from '../ui/useToast';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { GranularityEnforcementNotice, PlanEditorHeader } from './PlanEditorComponents';
import { PlanEditorMobileLayout } from './PlanEditorMobileLayout';

interface PlanEditorProps {
  draft: DraftWithPlan;
  originalPrompt?: string;
  onFinalize?: () => void;
  onBackToSetup?: () => void;
}

export const PlanEditor: React.FC<PlanEditorProps> = ({ draft, originalPrompt, onFinalize, onBackToSetup }) => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [enforcementNoticeDismissed, setEnforcementNoticeDismissed] = useState(false);
  const [showBackToSetupDialog, setShowBackToSetupDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isResettingToSetup, setIsResettingToSetup] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isChatExpanded, setIsChatExpanded] = useState(false);
  const { addToast } = useToast();
  const { isDemoMode } = useDemoMode();

  const planName = draft.name || draft.initial_prompt || 'Untitled Plan';
  const granularityEnforcement = draft.context_config?.granularityEnforcement;
  const repository = draft.repository || '';
  const baseBranch = draft.context_config?.baseBranch || 'main';

  const initialPlan = (() => {
    let planJson = draft.plan_json;
    if (typeof planJson === 'string') {
      try { planJson = JSON.parse(planJson); } catch { return []; }
    }
    return Array.isArray(planJson) ? planJson : [];
  })();

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

  const handleRefineRequest = useCallback(async (message: string, signal?: AbortSignal) => {
    if (isDemoMode) {
      return {
        success: false,
        message: 'Demo mode is read-only. Plan refinement is disabled.',
        cancelled: true,
      };
    }
    return handleRefine(message, signal);
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

  const handleFinalize = async () => {
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
  };

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

  if (isMobile) {
    return (
      <PlanEditorMobileLayout
        planName={planName}
        repository={repository}
        baseBranch={baseBranch}
        originalPrompt={originalPrompt}
        isDeleting={isDeleting}
        isFinalizing={isFinalizing}
        isResettingToSetup={isResettingToSetup}
        canUndo={canUndo && !isDemoMode}
        canRedo={canRedo && !isDemoMode}
        finalizeError={finalizeError}
        granularityEnforcement={granularityEnforcement}
        enforcementNoticeDismissed={enforcementNoticeDismissed}
        plan={plan}
        highlightedIds={highlightedIds}
        draftId={draft.draft_id}
        chatHistory={draft.chat_history}
        refinementProgress={refinementProgress}
        isChatExpanded={isChatExpanded}
        showBackToSetupDialog={showBackToSetupDialog}
        showDeleteDialog={showDeleteDialog}
        onDelete={() => setShowDeleteDialog(true)}
        onBackToSetup={() => setShowBackToSetupDialog(true)}
        onUndo={isDemoMode ? () => {} : undo}
        onRedo={isDemoMode ? () => {} : redo}
        onSetEnforcementNoticeDismissed={setEnforcementNoticeDismissed}
        onTaskChange={isDemoMode ? () => {} : updateTask}
        onDeleteTask={handleDeleteTask}
        onReorderTasks={isDemoMode ? () => {} : reorderTasks}
        onFinalize={handleFinalize}
        onSetChatExpanded={setIsChatExpanded}
        onRefine={handleRefineRequest}
        onChatMessagesChange={handleChatMessagesChange}
        onStopRefinement={handleStopRefinement}
        onSetShowBackToSetupDialog={setShowBackToSetupDialog}
        onSetShowDeleteDialog={setShowDeleteDialog}
        onBackToSetupConfirm={handleBackToSetup}
        onDeleteConfirm={handleDeletePlanConfirm}
        isReadOnly={isDemoMode}
      />
    );
  }

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      <PlanEditorHeader
        planName={planName}
        repository={repository}
        baseBranch={baseBranch}
        originalPrompt={originalPrompt}
        isDeleting={isDeleting}
        isFinalizing={isFinalizing}
        isResettingToSetup={isResettingToSetup}
        canUndo={canUndo && !isDemoMode}
        canRedo={canRedo && !isDemoMode}
        onDelete={() => { if (!isDemoMode) setShowDeleteDialog(true); }}
        onBackToSetup={() => { if (!isDemoMode) setShowBackToSetupDialog(true); }}
        onUndo={isDemoMode ? () => {} : undo}
        onRedo={isDemoMode ? () => {} : redo}
        isReadOnly={isDemoMode}
      />

      {finalizeError && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-red-700 text-sm flex items-center gap-2 flex-shrink-0">
          <AlertCircle size={14} />
          {finalizeError}
        </div>
      )}

      {granularityEnforcement && granularityEnforcement.enforced && !enforcementNoticeDismissed && (
        <GranularityEnforcementNotice
          enforcement={granularityEnforcement}
          onDismiss={() => setEnforcementNoticeDismissed(true)}
        />
      )}

      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={60} minSize={30}>
            <div className="h-full bg-white">
              <TaskCardList
                tasks={plan}
                highlightedIds={highlightedIds}
                draftId={draft.draft_id}
                onTaskChange={isDemoMode ? () => {} : updateTask}
                onDeleteTask={handleDeleteTask}
                onReorderTasks={isDemoMode ? () => {} : reorderTasks}
              />
            </div>
          </Panel>

          <PanelResizeHandle className="w-2 bg-gray-200 hover:bg-teal-500 transition-colors flex items-center justify-center cursor-col-resize">
            <GripVertical size={12} className="text-gray-400" />
          </PanelResizeHandle>

          <Panel defaultSize={40} minSize={25}>
            <div className="h-full bg-slate-50">
              <RefinementChat
                onSendMessage={handleRefineRequest}
                initialMessages={draft.chat_history}
                onMessagesChange={handleChatMessagesChange}
                refinementProgress={refinementProgress}
                onStop={handleStopRefinement}
              />
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <div className="flex items-center justify-between px-6 py-5 border-t border-gray-200 bg-gray-100 flex-shrink-0">
        <div className="flex items-center justify-between" style={{ width: 'calc(60% - 4px)' }}>
          <div className="text-sm text-gray-500">
            {plan.length} {plan.length === 1 ? 'task' : 'tasks'} in plan
          </div>
          <button
            onClick={handleFinalize}
            disabled={isFinalizing || plan.length === 0 || isDemoMode}
            className="flex items-center gap-2 px-5 py-2.5 text-white rounded-lg disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
            title={isDemoMode ? 'Demo mode is read-only' : undefined}
            style={{ backgroundColor: isFinalizing || plan.length === 0 || isDemoMode ? undefined : 'rgb(29, 138, 138)' }}
            onMouseEnter={(e) => { if (!isFinalizing && plan.length > 0 && !isDemoMode) e.currentTarget.style.backgroundColor = 'rgb(24, 118, 118)'; }}
            onMouseLeave={(e) => { if (!isFinalizing && plan.length > 0 && !isDemoMode) e.currentTarget.style.backgroundColor = 'rgb(29, 138, 138)'; }}
          >
            {isDemoMode ? (
              <>
                <Github size={16} />
                Read-only Demo
              </>
            ) : isFinalizing ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Creating Issues...
              </>
            ) : (
              <>
                <Github size={16} />
                Create {plan.length} GitHub {plan.length === 1 ? 'Issue' : 'Issues'}
              </>
            )}
          </button>
        </div>
        <div />
      </div>

      <BackToSetupDialog
        isOpen={showBackToSetupDialog}
        onClose={() => setShowBackToSetupDialog(false)}
        onConfirm={handleBackToSetup}
        isLoading={isResettingToSetup}
      />

      <DeletePlanDialog
        isOpen={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={handleDeletePlanConfirm}
        isLoading={isDeleting}
      />
    </div>
  );
};

export default PlanEditor;
