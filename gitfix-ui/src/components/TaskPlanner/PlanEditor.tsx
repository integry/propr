import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Undo2, Redo2, Loader2, AlertCircle, GripVertical, ArrowLeft, Github, GitBranch, Trash2 } from 'lucide-react';
import { debounce } from 'lodash';
import { usePlanRefinement } from '../../hooks/usePlanRefinement';
import { DraftWithPlan, finalizePlan, updateDraft, ChatMessage, resetDraftToSetup, abortRefinement, deleteDraft } from '../../api/proprApi';
import TaskCardList from './TaskCardList';
import RefinementChat from './RefinementChat';
import BackToSetupDialog from './BackToSetupDialog';
import DeletePlanDialog from './DeletePlanDialog';
import { useToast } from '../ui/useToast';
import { OriginalPromptPopover, GranularityEnforcementNotice } from './PlanEditorComponents';

interface PlanEditorProps {
  draft: DraftWithPlan;
  originalPrompt?: string;
  onFinalize?: () => void;
  onBackToSetup?: () => void;
}

interface PlanEditorHeaderProps {
  planName: string;
  repository: string;
  baseBranch: string;
  originalPrompt?: string;
  isDeleting: boolean;
  isFinalizing: boolean;
  isResettingToSetup: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onDelete: () => void;
  onBackToSetup: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

const PlanEditorHeader: React.FC<PlanEditorHeaderProps> = ({
  planName,
  repository,
  baseBranch,
  originalPrompt,
  isDeleting,
  isFinalizing,
  isResettingToSetup,
  canUndo,
  canRedo,
  onDelete,
  onBackToSetup,
  onUndo,
  onRedo
}) => {
  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-gray-100 flex-shrink-0 gap-4">
      <div className="flex items-center gap-4 min-w-0 flex-1">
        {/* Plan Name - responsive width based on available space */}
        <h1 className="text-lg font-semibold text-gray-900 truncate min-w-0 flex-shrink" title={planName}>
          {planName}
        </h1>
        <div className="h-4 w-px bg-gray-300 flex-shrink-0" />
        {/* Repository and Branch Breadcrumb */}
        <div className="flex items-center gap-2 text-sm flex-shrink-0">
          <Github size={16} className="text-gray-500" />
          <span className="font-medium text-gray-900 truncate max-w-[200px]" title={repository}>{repository}</span>
          <span className="text-gray-400">/</span>
          <GitBranch size={14} className="text-gray-500" />
          <span className="text-gray-600">{baseBranch}</span>
        </div>
        {/* Original Prompt - moved to header */}
        {originalPrompt && (
          <>
            <div className="h-4 w-px bg-gray-300 flex-shrink-0 hidden lg:block" />
            <div className="hidden lg:block">
              <OriginalPromptPopover prompt={originalPrompt} />
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Delete Plan */}
        <button
          onClick={onDelete}
          disabled={isFinalizing || isResettingToSetup || isDeleting}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Delete Plan"
        >
          {isDeleting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Trash2 size={16} />
          )}
        </button>
        <div className="h-6 w-px bg-gray-300 mx-1" />
        {/* Back to Setup */}
        <button
          onClick={onBackToSetup}
          disabled={isFinalizing || isResettingToSetup || isDeleting}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Back to Setup"
        >
          <ArrowLeft size={16} />
          Back to Setup
        </button>
        <div className="h-6 w-px bg-gray-300 mx-1" />
        {/* Undo/Redo */}
        <div className="flex items-center gap-1">
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="p-2 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Undo"
          >
            <Undo2 size={18} className="text-gray-600" />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="p-2 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Redo"
          >
            <Redo2 size={18} className="text-gray-600" />
          </button>
        </div>
      </div>
    </div>
  );
};

export const PlanEditor: React.FC<PlanEditorProps> = ({ draft, originalPrompt, onFinalize, onBackToSetup }) => {
  const navigate = useNavigate();
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [enforcementNoticeDismissed, setEnforcementNoticeDismissed] = useState(false);
  const [showBackToSetupDialog, setShowBackToSetupDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isResettingToSetup, setIsResettingToSetup] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { addToast } = useToast();

  // Plan name: prefer draft.name, fall back to initial_prompt
  const planName = draft.name || draft.initial_prompt || 'Untitled Plan';

  // Handle delete plan confirmation
  const handleDeletePlanConfirm = async () => {
    setIsDeleting(true);
    try {
      await deleteDraft(draft.draft_id);
      setShowDeleteDialog(false);
      addToast({
        type: 'success',
        message: 'Plan deleted successfully',
        duration: 3000
      });
      navigate('/plans');
    } catch (err) {
      addToast({
        type: 'error',
        message: (err as Error).message || 'Failed to delete plan',
        duration: 5000
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Extract granularity enforcement metadata from context_config
  const granularityEnforcement = draft.context_config?.granularityEnforcement;

  // Extract repository and branch info from draft
  const repository = draft.repository || '';
  const baseBranch = draft.context_config?.baseBranch || 'main';

  // Defensively ensure plan_json is an array
  const initialPlan = (() => {
    let planJson = draft.plan_json;
    if (typeof planJson === 'string') {
      try { planJson = JSON.parse(planJson); } catch { return []; }
    }
    return Array.isArray(planJson) ? planJson : [];
  })();

  const {
    plan,
    updateTask,
    deleteTask,
    restoreTask,
    reorderTasks,
    handleRefine,
    undo,
    redo,
    canUndo,
    canRedo,
    highlightedIds,
    refinementProgress
  } = usePlanRefinement(draft.draft_id, initialPlan);

  // Handle soft delete with undo toast
  const handleDeleteTask = useCallback((taskId: string) => {
    const deleted = deleteTask(taskId);
    if (deleted) {
      addToast({
        type: 'undo',
        message: `Task "${deleted.task.title}" deleted`,
        duration: 5000,
        onUndo: () => restoreTask(deleted)
      });
    }
  }, [deleteTask, restoreTask, addToast]);

  // Debounced save for chat history
  const saveChatHistoryRef = useRef(
    debounce(async (draftId: string, messages: ChatMessage[]) => {
      try {
        await updateDraft(draftId, { chat_history: messages });
      } catch (err) {
        console.error('Failed to save chat history:', err);
      }
    }, 1000)
  );

  const handleChatMessagesChange = useCallback((messages: ChatMessage[]) => {
    saveChatHistoryRef.current(draft.draft_id, messages);
  }, [draft.draft_id]);

  const handleStopRefinement = useCallback(async () => {
    await abortRefinement(draft.draft_id);
  }, [draft.draft_id]);

  const handleFinalize = async () => {
    setIsFinalizing(true);
    setFinalizeError(null);
    try {
      const result = await finalizePlan(draft.draft_id);
      if (result.alreadyExecuted) {
        addToast({
          type: 'warning',
          message: 'This plan has already been finalized. No new issues were created.',
          duration: 5000
        });
      }
      onFinalize?.();
    } catch (err) {
      setFinalizeError((err as Error).message || 'Failed to create issues');
    } finally {
      setIsFinalizing(false);
    }
  };

  const handleBackToSetup = async () => {
    setIsResettingToSetup(true);
    try {
      await resetDraftToSetup(draft.draft_id);
      setShowBackToSetupDialog(false);
      onBackToSetup?.();
    } catch (err) {
      addToast({
        type: 'error',
        message: (err as Error).message || 'Failed to reset draft',
        duration: 5000
      });
    } finally {
      setIsResettingToSetup(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      {/* Pro Studio Header - Gray background with repo/branch breadcrumb */}
      <PlanEditorHeader
        planName={planName}
        repository={repository}
        baseBranch={baseBranch}
        originalPrompt={originalPrompt}
        isDeleting={isDeleting}
        isFinalizing={isFinalizing}
        isResettingToSetup={isResettingToSetup}
        canUndo={canUndo}
        canRedo={canRedo}
        onDelete={() => setShowDeleteDialog(true)}
        onBackToSetup={() => setShowBackToSetupDialog(true)}
        onUndo={undo}
        onRedo={redo}
      />

      {/* Error and Notice Banners */}
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

      {/* Main Content Area - Dual Pane Layout */}
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* Left Panel - Plan Canvas */}
          <Panel defaultSize={60} minSize={30}>
            <div className="h-full bg-white">
              <TaskCardList
                tasks={plan}
                highlightedIds={highlightedIds}
                draftId={draft.draft_id}
                onTaskChange={updateTask}
                onDeleteTask={handleDeleteTask}
                onReorderTasks={reorderTasks}
              />
            </div>
          </Panel>

          <PanelResizeHandle className="w-2 bg-gray-200 hover:bg-teal-500 transition-colors flex items-center justify-center cursor-col-resize">
            <GripVertical size={12} className="text-gray-400" />
          </PanelResizeHandle>

          {/* Right Panel - Assistant Sidebar with slate background */}
          <Panel defaultSize={40} minSize={25}>
            <div className="h-full bg-slate-50">
              <RefinementChat
                onSendMessage={handleRefine}
                initialMessages={draft.chat_history}
                onMessagesChange={handleChatMessagesChange}
refinementProgress={refinementProgress}
                onStop={handleStopRefinement}
              />
            </div>
          </Panel>
        </PanelGroup>
      </div>

      {/* Pro Studio Footer - Gray background with primary action aligned to right of left column */}
      <div className="flex items-center justify-between px-6 py-5 border-t border-gray-200 bg-gray-100 flex-shrink-0">
        {/* Left column area (60% width to match left panel) - task count on left, button on right */}
        <div className="flex items-center justify-between" style={{ width: 'calc(60% - 4px)' }}>
          <div className="text-sm text-gray-500">
            {plan.length} {plan.length === 1 ? 'task' : 'tasks'} in plan
          </div>
          <button
            onClick={handleFinalize}
            disabled={isFinalizing || plan.length === 0}
            className="flex items-center gap-2 px-5 py-2.5 text-white rounded-lg disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
            style={{ backgroundColor: isFinalizing || plan.length === 0 ? undefined : 'rgb(29, 138, 138)' }}
            onMouseEnter={(e) => { if (!isFinalizing && plan.length > 0) e.currentTarget.style.backgroundColor = 'rgb(24, 118, 118)'; }}
            onMouseLeave={(e) => { if (!isFinalizing && plan.length > 0) e.currentTarget.style.backgroundColor = 'rgb(29, 138, 138)'; }}
          >
            {isFinalizing ? (
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
        {/* Right side: Empty space for separation from chat interface */}
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
