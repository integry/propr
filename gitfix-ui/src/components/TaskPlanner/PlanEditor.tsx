import React, { useState, useCallback, useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Undo2, Redo2, Check, Loader2, AlertCircle, FileText, GripVertical, Info, X, ArrowLeft, ChevronDown, FileQuestion } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { debounce } from 'lodash';
import { usePlanRefinement, SaveStatus } from '../../hooks/usePlanRefinement';
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

interface OriginalPromptSectionProps {
  prompt: string;
}

const OriginalPromptSection: React.FC<OriginalPromptSectionProps> = ({ prompt }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border-b border-gray-200 bg-slate-50">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-100 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <FileQuestion size={14} />
          <span className="font-medium">Original Prompt</span>
        </div>
        <motion.div
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronDown size={16} className="text-slate-400" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 pt-1">
              <div className="bg-white rounded-lg border border-slate-200 p-3">
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{prompt}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const SaveIndicator: React.FC<{ status: SaveStatus }> = ({ status }) => {
  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1 text-yellow-600 text-sm">
        <Loader2 size={14} className="animate-spin" />
        Saving...
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-red-600 text-sm">
        <AlertCircle size={14} />
        Error saving
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-green-600 text-sm">
      <Check size={14} />
      Saved
    </span>
  );
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700',
    review: 'bg-blue-100 text-blue-700',
    approved: 'bg-green-100 text-green-700'
  };
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${colors[status] || colors.draft}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
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
    addTask,
    deleteTask,
    restoreTask,
    reorderTasks,
    handleRefine,
    undo,
    redo,
    canUndo,
    canRedo,
    saveStatus,
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
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-4">
          <div className="text-sm text-gray-500 truncate max-w-md">{(draft as DraftWithPlan & { name?: string }).name || draft.initial_prompt || 'Untitled Task'}</div>
          <StatusBadge status={draft.status} />
          <SaveIndicator status={saveStatus} />
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowBackToSetupDialog(true)}
            disabled={isFinalizing || isResettingToSetup}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed mr-2 border-r pr-4"
            title="Back to Setup"
          >
            <ArrowLeft size={16} />
            Back to Setup
          </button>
          <div className="flex items-center gap-1 mr-4 border-r pr-4">
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
          
          <button
            onClick={handleFinalize}
            disabled={isFinalizing || plan.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-white rounded-lg disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
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
                <FileText size={16} />
                Create GitHub Issues
              </>
            )}
          </button>
        </div>
      </div>

      {finalizeError && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-red-700 text-sm flex items-center gap-2">
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

      {originalPrompt && (
        <OriginalPromptSection prompt={originalPrompt} />
      )}

      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          <Panel defaultSize={60} minSize={30}>
            <TaskCardList
              tasks={plan}
              highlightedIds={highlightedIds}
              onTaskChange={updateTask}
              onAddTask={addTask}
              onDeleteTask={handleDeleteTask}
              onReorderTasks={reorderTasks}
            />
          </Panel>
          
          <PanelResizeHandle className="w-2 bg-gray-200 hover:bg-teal-500 transition-colors flex items-center justify-center cursor-col-resize">
            <GripVertical size={12} className="text-gray-400" />
          </PanelResizeHandle>
          
          <Panel defaultSize={40} minSize={25}>
            <RefinementChat
              onSendMessage={handleRefine}
              initialMessages={draft.chat_history}
              onMessagesChange={handleChatMessagesChange}
            />
          </Panel>
        </PanelGroup>
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
