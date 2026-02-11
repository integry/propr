import React, { useState, useCallback, useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Undo2, Redo2, Loader2, AlertCircle, GripVertical, Info, X, ArrowLeft, FileQuestion, Github, GitBranch } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { debounce } from 'lodash';
import { usePlanRefinement } from '../../hooks/usePlanRefinement';
import { DraftWithPlan, finalizePlan, updateDraft, ChatMessage, GranularityEnforcementMetadata, resetDraftToSetup } from '../../api/gitfixApi';
import TaskCardList from './TaskCardList';
import RefinementChat from './RefinementChat';
import BackToSetupDialog from './BackToSetupDialog';
import { useToast } from '../ui/useToast';

interface PlanEditorProps {
  draft: DraftWithPlan;
  originalPrompt?: string;
  onFinalize?: () => void;
  onBackToSetup?: () => void;
}

interface OriginalPromptPopoverProps {
  prompt: string;
}

const OriginalPromptPopover: React.FC<OriginalPromptPopoverProps> = ({ prompt }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-200 px-2 py-1 rounded transition-colors"
        title="View original prompt"
      >
        <FileQuestion size={14} />
        <span className="hidden sm:inline">Prompt</span>
      </button>
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setIsOpen(false)}
            />
            {/* Popover */}
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="absolute top-full left-0 mt-2 z-50 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden"
            >
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Original Prompt</span>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1 hover:bg-gray-200 rounded transition-colors"
                >
                  <X size={14} className="text-gray-400" />
                </button>
              </div>
              <div className="p-3 max-h-60 overflow-y-auto">
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{prompt}</p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

interface GranularityEnforcementNoticeProps {
  enforcement: GranularityEnforcementMetadata;
  onDismiss: () => void;
}

const GranularityEnforcementNotice: React.FC<GranularityEnforcementNoticeProps> = ({ enforcement, onDismiss }) => {
  if (!enforcement.enforced) return null;

  return (
    <div className="px-4 py-2 bg-blue-50 border-b border-blue-200 text-blue-700 text-sm flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Info size={14} />
        <span>{enforcement.message || `${enforcement.originalTaskCount} tasks merged into ${enforcement.finalTaskCount} per your Single Task setting`}</span>
      </div>
      <button
        onClick={onDismiss}
        className="p-1 hover:bg-blue-100 rounded transition-colors"
        title="Dismiss"
        aria-label="Dismiss granularity enforcement notice"
      >
        <X size={14} />
      </button>
    </div>
  );
};

export const PlanEditor: React.FC<PlanEditorProps> = ({ draft, originalPrompt, onFinalize, onBackToSetup }) => {
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [enforcementNoticeDismissed, setEnforcementNoticeDismissed] = useState(false);
  const [showBackToSetupDialog, setShowBackToSetupDialog] = useState(false);
  const [isResettingToSetup, setIsResettingToSetup] = useState(false);
  const { addToast } = useToast();

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
    highlightedIds
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
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-gray-100 flex-shrink-0">
        <div className="flex items-center gap-4">
          {/* Repository and Branch Breadcrumb */}
          <div className="flex items-center gap-2 text-sm">
            <Github size={16} className="text-gray-500" />
            <span className="font-medium text-gray-900">{repository}</span>
            <span className="text-gray-400">/</span>
            <GitBranch size={14} className="text-gray-500" />
            <span className="text-gray-600">{baseBranch}</span>
          </div>
          {/* Original Prompt - moved to header */}
          {originalPrompt && (
            <>
              <div className="h-4 w-px bg-gray-300" />
              <OriginalPromptPopover prompt={originalPrompt} />
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Back to Setup */}
          <button
            onClick={() => setShowBackToSetupDialog(true)}
            disabled={isFinalizing || isResettingToSetup}
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
              onClick={undo}
              disabled={!canUndo}
              className="p-2 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Undo"
            >
              <Undo2 size={18} className="text-gray-600" />
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              className="p-2 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Redo"
            >
              <Redo2 size={18} className="text-gray-600" />
            </button>
          </div>
        </div>
      </div>

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
              />
            </div>
          </Panel>
        </PanelGroup>
      </div>

      {/* Pro Studio Footer - Gray background with primary action */}
      <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 bg-gray-100 flex-shrink-0">
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

      <BackToSetupDialog
        isOpen={showBackToSetupDialog}
        onClose={() => setShowBackToSetupDialog(false)}
        onConfirm={handleBackToSetup}
        isLoading={isResettingToSetup}
      />
    </div>
  );
};

export default PlanEditor;
