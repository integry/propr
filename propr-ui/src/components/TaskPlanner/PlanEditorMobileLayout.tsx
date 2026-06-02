import React from 'react';
import { Loader2, Github, MessageCircle, X } from 'lucide-react';
import { GranularityEnforcementMetadata, ChatMessage, PlanTask } from '../../api/proprApi';
import TaskCardList from './TaskCardList';
import RefinementChat from './RefinementChat';
import BackToSetupDialog from './BackToSetupDialog';
import DeletePlanDialog from './DeletePlanDialog';
import { RefinementProgress } from '../../hooks/usePlanRefinement';
import { PlanEditorHeader, PlanEditorErrorBanner, GranularityEnforcementNotice } from './PlanEditorComponents';

export interface PlanEditorMobileLayoutProps {
  planName: string;
  repository: string;
  baseBranch: string;
  originalPrompt?: string;
  isDeleting: boolean;
  isFinalizing: boolean;
  isResettingToSetup: boolean;
  canUndo: boolean;
  canRedo: boolean;
  finalizeError: string | null;
  granularityEnforcement?: { enforced: boolean; message?: string; originalTaskCount?: number; finalTaskCount?: number };
  enforcementNoticeDismissed: boolean;
  plan: PlanTask[];
  highlightedIds: Set<string>;
  draftId: string;
  chatHistory?: ChatMessage[];
  refinementProgress?: RefinementProgress;
  isChatExpanded: boolean;
  showBackToSetupDialog: boolean;
  showDeleteDialog: boolean;
  onDelete: () => void;
  onBackToSetup: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSetEnforcementNoticeDismissed: (value: boolean) => void;
  onTaskChange: (taskId: string, updates: Partial<PlanTask>) => void;
  onDeleteTask: (taskId: string) => void;
  onReorderTasks: (taskIds: string[]) => void;
  onFinalize: () => void;
  onSetChatExpanded: (value: boolean) => void;
  onRefine: (message: string, signal?: AbortSignal) => Promise<{ success: boolean; message: string; action?: 'modified' | 'answered' | 'both'; cancelled?: boolean }>;
  onChatMessagesChange: (messages: ChatMessage[]) => void;
  onStopRefinement: () => Promise<void>;
  onSetShowBackToSetupDialog: (value: boolean) => void;
  onSetShowDeleteDialog: (value: boolean) => void;
  onBackToSetupConfirm: () => Promise<void>;
  onDeleteConfirm: () => Promise<void>;
  isReadOnly?: boolean;
}

export const PlanEditorMobileLayout: React.FC<PlanEditorMobileLayoutProps> = ({
  planName,
  repository,
  baseBranch,
  originalPrompt,
  isDeleting,
  isFinalizing,
  isResettingToSetup,
  canUndo,
  canRedo,
  finalizeError,
  granularityEnforcement,
  enforcementNoticeDismissed,
  plan,
  highlightedIds,
  draftId,
  chatHistory,
  refinementProgress,
  isChatExpanded,
  showBackToSetupDialog,
  showDeleteDialog,
  onDelete,
  onBackToSetup,
  onUndo,
  onRedo,
  onSetEnforcementNoticeDismissed,
  onTaskChange,
  onDeleteTask,
  onReorderTasks,
  onFinalize,
  onSetChatExpanded,
  onRefine,
  onChatMessagesChange,
  onStopRefinement,
  onSetShowBackToSetupDialog,
  onSetShowDeleteDialog,
  onBackToSetupConfirm,
  onDeleteConfirm,
  isReadOnly = false
}) => {
  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      {/* Mobile Header */}
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
        onDelete={onDelete}
        onBackToSetup={onBackToSetup}
        onUndo={onUndo}
        onRedo={onRedo}
        isMobile={true}
        isReadOnly={isReadOnly}
      />

      {/* Error and Notice Banners */}
      <PlanEditorErrorBanner error={finalizeError} isMobile />

      {granularityEnforcement && granularityEnforcement.enforced && !enforcementNoticeDismissed && (
        <GranularityEnforcementNotice
          enforcement={granularityEnforcement as GranularityEnforcementMetadata}
          onDismiss={() => onSetEnforcementNoticeDismissed(true)}
        />
      )}

      {/* Main Content - Full width task list */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full bg-white">
          <TaskCardList
            tasks={plan}
            highlightedIds={highlightedIds}
            draftId={draftId}
            onTaskChange={onTaskChange}
            onDeleteTask={onDeleteTask}
            onReorderTasks={onReorderTasks}
          />
        </div>
      </div>

      {/* Mobile Footer - Compact with chat toggle */}
      <div className="flex items-center justify-between px-3 py-3 border-t border-gray-200 bg-gray-100 flex-shrink-0 gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSetChatExpanded(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <MessageCircle size={16} />
            <span>Refine</span>
          </button>
          <span className="text-xs text-gray-500">
            {plan.length} {plan.length === 1 ? 'task' : 'tasks'}
          </span>
        </div>
        <button
          onClick={onFinalize}
          disabled={isFinalizing || plan.length === 0 || isReadOnly}
          title={isReadOnly ? 'Demo mode is read-only' : undefined}
          className="flex items-center gap-1.5 px-4 py-2 text-sm text-white rounded-lg disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
          style={{ backgroundColor: isFinalizing || plan.length === 0 || isReadOnly ? undefined : 'rgb(29, 138, 138)' }}
        >
          {isReadOnly ? (
            <>
              <Github size={14} />
              <span>Read-only</span>
            </>
          ) : isFinalizing ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              <span>Creating...</span>
            </>
          ) : (
            <>
              <Github size={14} />
              <span>Create Issues</span>
            </>
          )}
        </button>
      </div>

      {/* Mobile Chat Bottom Sheet */}
      {isChatExpanded && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white">
          {/* Chat Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-slate-50 flex-shrink-0">
            <h3 className="font-semibold text-gray-900">Refine Plan</h3>
            <button
              onClick={() => onSetChatExpanded(false)}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X size={20} />
            </button>
          </div>
          {/* Chat Content */}
          <div className="flex-1 overflow-hidden">
            <RefinementChat
              onSendMessage={onRefine}
              initialMessages={chatHistory}
              onMessagesChange={onChatMessagesChange}
              refinementProgress={refinementProgress}
              onStop={onStopRefinement}
            />
          </div>
        </div>
      )}

      <BackToSetupDialog
        isOpen={showBackToSetupDialog}
        onClose={() => onSetShowBackToSetupDialog(false)}
        onConfirm={onBackToSetupConfirm}
        isLoading={isResettingToSetup}
      />

      <DeletePlanDialog
        isOpen={showDeleteDialog}
        onClose={() => onSetShowDeleteDialog(false)}
        onConfirm={onDeleteConfirm}
        isLoading={isDeleting}
      />
    </div>
  );
};

export default PlanEditorMobileLayout;
