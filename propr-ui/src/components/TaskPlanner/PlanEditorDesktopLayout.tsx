import React from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Loader2, GripVertical, Github } from 'lucide-react';
import type { ChatMessage, GranularityEnforcementMetadata, PlanTask } from '../../api/proprApi';
import type { usePlanRefinement } from '../../hooks/usePlanRefinement';
import TaskCardList from './TaskCardList';
import RefinementChat from './RefinementChat';
import BackToSetupDialog from './BackToSetupDialog';
import DeletePlanDialog from './DeletePlanDialog';
import { GranularityEnforcementNotice, PlanEditorErrorBanner, PlanEditorHeader } from './PlanEditorComponents';

type PlanRefinementState = ReturnType<typeof usePlanRefinement>;

const isFinalizeDisabled = (isFinalizing: boolean, planLength: number, isReadOnly: boolean) => (
  isFinalizing || planLength === 0 || isReadOnly
);

const getFinalizeButtonStyle = (isDisabled: boolean) => ({
  backgroundColor: isDisabled ? undefined : 'rgb(29, 138, 138)'
});

interface PlanEditorNoticesProps {
  finalizeError: string | null;
  granularityEnforcement?: GranularityEnforcementMetadata;
  enforcementNoticeDismissed: boolean;
  onDismissEnforcementNotice: () => void;
}

const PlanEditorNotices: React.FC<PlanEditorNoticesProps> = ({
  finalizeError,
  granularityEnforcement,
  enforcementNoticeDismissed,
  onDismissEnforcementNotice
}) => (
  <>
    <PlanEditorErrorBanner error={finalizeError} />
    {granularityEnforcement && granularityEnforcement.enforced && !enforcementNoticeDismissed && (
      <GranularityEnforcementNotice
        enforcement={granularityEnforcement}
        onDismiss={onDismissEnforcementNotice}
      />
    )}
  </>
);

interface PlanEditorPanelsProps {
  plan: PlanTask[];
  highlightedIds: string[];
  draftId: string;
  chatHistory?: ChatMessage[];
  refinementProgress: PlanRefinementState['refinementProgress'];
  defaultModel?: string | null;
  onTaskChange: PlanRefinementState['updateTask'];
  onDeleteTask: (taskId: string) => void;
  onReorderTasks: PlanRefinementState['reorderTasks'];
  onRefine: PlanRefinementState['handleRefine'];
  onChatMessagesChange: (messages: ChatMessage[]) => void;
  onStopRefinement: () => Promise<void>;
}

const PlanEditorPanels: React.FC<PlanEditorPanelsProps> = ({
  plan,
  highlightedIds,
  draftId,
  chatHistory,
  refinementProgress,
  defaultModel,
  onTaskChange,
  onDeleteTask,
  onReorderTasks,
  onRefine,
  onChatMessagesChange,
  onStopRefinement
}) => (
  <div className="flex-1 overflow-hidden">
    <PanelGroup direction="horizontal">
      <Panel defaultSize={60} minSize={30}>
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
      </Panel>

      <PanelResizeHandle className="w-2 bg-gray-200 hover:bg-teal-500 transition-colors flex items-center justify-center cursor-col-resize">
        <GripVertical size={12} className="text-gray-400" />
      </PanelResizeHandle>

      <Panel defaultSize={40} minSize={25}>
        <div className="h-full bg-slate-50">
          <RefinementChat
            onSendMessage={onRefine}
            initialMessages={chatHistory}
            onMessagesChange={onChatMessagesChange}
            refinementProgress={refinementProgress}
            defaultModel={defaultModel}
            onStop={onStopRefinement}
          />
        </div>
      </Panel>
    </PanelGroup>
  </div>
);

const FinalizeButtonContent: React.FC<{ isReadOnly: boolean; isFinalizing: boolean; planLength: number }> = ({
  isReadOnly,
  isFinalizing,
  planLength
}) => {
  if (isReadOnly) {
    return (
      <>
        <Github size={16} />
        Read-only Demo
      </>
    );
  }

  if (isFinalizing) {
    return (
      <>
        <Loader2 size={16} className="animate-spin" />
        Creating Issues...
      </>
    );
  }

  return (
    <>
      <Github size={16} />
      Create {planLength} GitHub {planLength === 1 ? 'Issue' : 'Issues'}
    </>
  );
};

interface PlanEditorFooterProps {
  planLength: number;
  isFinalizing: boolean;
  isReadOnly: boolean;
  onFinalize: () => void;
}

const PlanEditorFooter: React.FC<PlanEditorFooterProps> = ({ planLength, isFinalizing, isReadOnly, onFinalize }) => {
  const finalizeDisabled = isFinalizeDisabled(isFinalizing, planLength, isReadOnly);

  return (
    <div className="flex items-center justify-between px-6 py-5 border-t border-gray-200 bg-gray-100 flex-shrink-0">
      <div className="flex items-center justify-between" style={{ width: 'calc(60% - 4px)' }}>
        <div className="text-sm text-gray-500">
          {planLength} {planLength === 1 ? 'task' : 'tasks'} in plan
        </div>
        <button
          onClick={onFinalize}
          disabled={finalizeDisabled}
          className="flex items-center gap-2 px-5 py-2.5 text-white rounded-lg disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
          title={isReadOnly ? 'Demo mode is read-only' : undefined}
          style={getFinalizeButtonStyle(finalizeDisabled)}
          onMouseEnter={(e) => { if (!finalizeDisabled) e.currentTarget.style.backgroundColor = 'rgb(24, 118, 118)'; }}
          onMouseLeave={(e) => { if (!finalizeDisabled) e.currentTarget.style.backgroundColor = 'rgb(29, 138, 138)'; }}
        >
          <FinalizeButtonContent
            isReadOnly={isReadOnly}
            isFinalizing={isFinalizing}
            planLength={planLength}
          />
        </button>
      </div>
      <div />
    </div>
  );
};

interface PlanEditorDialogsProps {
  showBackToSetupDialog: boolean;
  showDeleteDialog: boolean;
  isResettingToSetup: boolean;
  isDeleting: boolean;
  onSetShowBackToSetupDialog: React.Dispatch<React.SetStateAction<boolean>>;
  onSetShowDeleteDialog: React.Dispatch<React.SetStateAction<boolean>>;
  onBackToSetupConfirm: () => Promise<void>;
  onDeleteConfirm: () => Promise<void>;
}

const PlanEditorDialogs: React.FC<PlanEditorDialogsProps> = ({
  showBackToSetupDialog,
  showDeleteDialog,
  isResettingToSetup,
  isDeleting,
  onSetShowBackToSetupDialog,
  onSetShowDeleteDialog,
  onBackToSetupConfirm,
  onDeleteConfirm
}) => (
  <>
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
  </>
);

export interface PlanEditorDesktopLayoutProps {
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
  granularityEnforcement?: GranularityEnforcementMetadata;
  enforcementNoticeDismissed: boolean;
  plan: PlanTask[];
  highlightedIds: string[];
  draftId: string;
  chatHistory?: ChatMessage[];
  refinementProgress: PlanRefinementState['refinementProgress'];
  defaultModel?: string | null;
  showBackToSetupDialog: boolean;
  showDeleteDialog: boolean;
  onDelete: () => void;
  onBackToSetup: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDismissEnforcementNotice: () => void;
  onTaskChange: PlanRefinementState['updateTask'];
  onDeleteTask: (taskId: string) => void;
  onReorderTasks: PlanRefinementState['reorderTasks'];
  onFinalize: () => void;
  onRefine: PlanRefinementState['handleRefine'];
  onChatMessagesChange: (messages: ChatMessage[]) => void;
  onStopRefinement: () => Promise<void>;
  onSetShowBackToSetupDialog: React.Dispatch<React.SetStateAction<boolean>>;
  onSetShowDeleteDialog: React.Dispatch<React.SetStateAction<boolean>>;
  onBackToSetupConfirm: () => Promise<void>;
  onDeleteConfirm: () => Promise<void>;
  isReadOnly: boolean;
}

export const PlanEditorDesktopLayout: React.FC<PlanEditorDesktopLayoutProps> = ({
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
  defaultModel,
  showBackToSetupDialog,
  showDeleteDialog,
  onDelete,
  onBackToSetup,
  onUndo,
  onRedo,
  onDismissEnforcementNotice,
  onTaskChange,
  onDeleteTask,
  onReorderTasks,
  onFinalize,
  onRefine,
  onChatMessagesChange,
  onStopRefinement,
  onSetShowBackToSetupDialog,
  onSetShowDeleteDialog,
  onBackToSetupConfirm,
  onDeleteConfirm,
  isReadOnly
}) => (
  <div className="h-full flex flex-col bg-white overflow-hidden">
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
      isReadOnly={isReadOnly}
    />

    <PlanEditorNotices
      finalizeError={finalizeError}
      granularityEnforcement={granularityEnforcement}
      enforcementNoticeDismissed={enforcementNoticeDismissed}
      onDismissEnforcementNotice={onDismissEnforcementNotice}
    />

    <PlanEditorPanels
      plan={plan}
      highlightedIds={highlightedIds}
      draftId={draftId}
      chatHistory={chatHistory}
      refinementProgress={refinementProgress}
      defaultModel={defaultModel}
      onTaskChange={onTaskChange}
      onDeleteTask={onDeleteTask}
      onReorderTasks={onReorderTasks}
      onRefine={onRefine}
      onChatMessagesChange={onChatMessagesChange}
      onStopRefinement={onStopRefinement}
    />

    <PlanEditorFooter
      planLength={plan.length}
      isFinalizing={isFinalizing}
      isReadOnly={isReadOnly}
      onFinalize={onFinalize}
    />

    <PlanEditorDialogs
      showBackToSetupDialog={showBackToSetupDialog}
      showDeleteDialog={showDeleteDialog}
      isResettingToSetup={isResettingToSetup}
      isDeleting={isDeleting}
      onSetShowBackToSetupDialog={onSetShowBackToSetupDialog}
      onSetShowDeleteDialog={onSetShowDeleteDialog}
      onBackToSetupConfirm={onBackToSetupConfirm}
      onDeleteConfirm={onDeleteConfirm}
    />
  </div>
);
