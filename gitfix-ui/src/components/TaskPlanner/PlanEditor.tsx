import React, { useState, useCallback, useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Undo2, Redo2, Check, Loader2, AlertCircle, FileText, GripVertical, Info, X } from 'lucide-react';
import { debounce } from 'lodash';
import { usePlanRefinement, SaveStatus } from '../../hooks/usePlanRefinement';
import { DraftWithPlan, finalizePlan, updateDraft, ChatMessage, GranularityEnforcementMetadata } from '../../api/gitfixApi';
import TaskCardList from './TaskCardList';
import RefinementChat from './RefinementChat';
import { useToast } from '../ui/useToast';

interface PlanEditorProps {
  draft: DraftWithPlan;
  onFinalize?: () => void;
}

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

export const PlanEditor: React.FC<PlanEditorProps> = ({ draft, onFinalize }) => {
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [enforcementNoticeDismissed, setEnforcementNoticeDismissed] = useState(false);
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

  return (
    <div className="h-full flex flex-col bg-white rounded-lg shadow overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
        <div className="flex items-center gap-4">
          <div className="text-sm text-gray-500 truncate max-w-md">{(draft as DraftWithPlan & { name?: string }).name || draft.initial_prompt || 'Untitled Task'}</div>
          <StatusBadge status={draft.status} />
          <SaveIndicator status={saveStatus} />
        </div>
        
        <div className="flex items-center gap-2">
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
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
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
          
          <PanelResizeHandle className="w-2 bg-gray-200 hover:bg-indigo-400 transition-colors flex items-center justify-center cursor-col-resize">
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
    </div>
  );
};

export default PlanEditor;
