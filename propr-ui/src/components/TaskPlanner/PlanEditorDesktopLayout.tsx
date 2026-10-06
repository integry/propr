import React, { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { GripVertical } from 'lucide-react';
import type { ChatMessage, GranularityEnforcementMetadata, PlanTask } from '../../api/proprApi';
import type { usePlanRefinement } from '../../hooks/usePlanRefinement';
import TaskCardList from './TaskCardList';
import RefinementChat from './RefinementChat';
import BackToSetupDialog from './BackToSetupDialog';
import DeletePlanDialog from './DeletePlanDialog';
import { GranularityEnforcementNotice, PlanEditorErrorBanner, PlanEditorHeader } from './PlanEditorComponents';

type PlanRefinementState = ReturnType<typeof usePlanRefinement>;

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
  focusComposerRequest?: number;
  isAssistantOpen: boolean;
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
  onStopRefinement,
  focusComposerRequest,
  isAssistantOpen,
}) => (
  <div className="flex-1 overflow-hidden">
    <PanelGroup direction="horizontal">
      <Panel id="plan-specification" order={1} defaultSize={60} minSize={30}>
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

      {isAssistantOpen && (
        <>
          <PanelResizeHandle className="w-2 bg-gray-200 hover:bg-teal-500 transition-colors flex items-center justify-center cursor-col-resize">
            <GripVertical size={12} className="text-gray-400" />
          </PanelResizeHandle>

          <Panel id="plan-assistant" order={2} defaultSize={40} minSize={25}>
            <div className="h-full bg-slate-50">
              <RefinementChat
                onSendMessage={onRefine}
                initialMessages={chatHistory}
                onMessagesChange={onChatMessagesChange}
                refinementProgress={refinementProgress}
                defaultModel={defaultModel}
                onStop={onStopRefinement}
                focusComposerRequest={focusComposerRequest}
              />
            </div>
          </Panel>
        </>
      )}
    </PanelGroup>
  </div>
);

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
    onShowHistory?: () => void;
    onDismissEnforcementNotice: () => void;
    onTaskChange: PlanRefinementState['updateTask'];
    onDeleteTask: (taskId: string) => void;
    onReorderTasks: PlanRefinementState['reorderTasks'];
    onFinalize: () => void;
    onRefine: PlanRefinementState['handleRefine'];
    onChatMessagesChange: (messages: ChatMessage[]) => void;
    onStopRefinement: () => Promise<void>;
    focusComposerRequest?: number;
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
    onShowHistory,
    onDismissEnforcementNotice,
    onTaskChange,
    onDeleteTask,
    onReorderTasks,
    onFinalize,
    onRefine,
    onChatMessagesChange,
    onStopRefinement,
    focusComposerRequest,
    onSetShowBackToSetupDialog,
    onSetShowDeleteDialog,
    onBackToSetupConfirm,
    onDeleteConfirm,
    isReadOnly
  }) => {
    const [isAssistantOpen, setIsAssistantOpen] = useState(true);

    // A request to focus the composer (e.g. from a notification) must bring the Assistant back
    useEffect(() => {
      if (focusComposerRequest) setIsAssistantOpen(true);
    }, [focusComposerRequest]);

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
        canUndo={canUndo}
        canRedo={canRedo}
        onDelete={onDelete}
        onBackToSetup={onBackToSetup}
        onUndo={onUndo}
        onRedo={onRedo}
        onShowHistory={onShowHistory}
        isReadOnly={isReadOnly}
        isAssistantOpen={isAssistantOpen}
        onToggleAssistant={() => setIsAssistantOpen(open => !open)}
        planLength={plan.length}
        onFinalize={onFinalize}
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
        focusComposerRequest={focusComposerRequest}
        isAssistantOpen={isAssistantOpen}
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
};
