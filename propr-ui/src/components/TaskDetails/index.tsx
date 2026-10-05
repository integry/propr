import React, { useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { renderMarkdown } from './renderMarkdown';
import ThinkingLog from './ThinkingLog';
import ExecutionEventLog from './ExecutionEventLog';
import ResultOverview from './ResultOverview';
import PromptModal from './PromptModal';
import LogFilesModal from './LogFilesModal';
import FollowupModal from './FollowupModal';
import ContextStrip from './ContextStrip';
import ActionBar from './ActionBar';
import TaskHeader, { ReturnToRunButton } from './TaskHeader';
import ProgressBar from './ProgressBar';
import LeftPaneBody from './LeftPaneBody';
import SectionLabelHeader from './SectionLabelHeader';
import TaskVisualPreviews from './TaskVisualPreviews';
import { useTaskData, usePromptData, useLogFilesData } from './hooks';
import { useThinkingLog } from './useThinkingLog';
import { getHistoryDerivedData } from './useHistoryData';
import { getCleanDocumentTitle } from '../TaskList/utils.tsx';
import { useToast } from '../ui/useToast';
import { postTaskFollowup } from '../../api/proprApi';
import { useConsumedReviewCommentIds, useTokenUsage } from './useDerivedTaskData';
import { useClickOutsideCollapse } from './useClickOutsideCollapse';
import { sanitizeTaskTitle, type TaskRunEntry } from '../TaskList/rowModel';
import DesktopTaskHeader from './DesktopTaskHeader';
import { useTaskHeaderView } from './useTaskHeaderView';
import { useLiveRunStop } from './useLiveRunStop';

const CenteredStatus: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <div className="h-full bg-white flex items-center justify-center">
    <div className={className}>{children}</div>
  </div>
);

const MobileStickySummary: React.FC<{
  title: string;
  contextStripProps: React.ComponentProps<typeof ContextStrip>;
  actionBarProps: React.ComponentProps<typeof ActionBar>;
  todos: React.ComponentProps<typeof ProgressBar>['todos'];
}> = ({ title, contextStripProps, actionBarProps, todos }) => (
  // Page-local sticky UI should sit below the global header dropdown stacking
  // context while remaining sticky within the task details route.
  <div className="task-mobile-sticky-summary sm:hidden sticky top-0 z-10 flex-shrink-0 bg-white">
    <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-200">
      <div className="flex flex-col gap-2">
        <div className="truncate text-xs font-semibold text-slate-700">{title}</div>
        <div className="flex min-w-0 items-center gap-2">
          <ContextStrip {...contextStripProps} mobileRepoOnly={true} />
        </div>
        <ActionBar {...actionBarProps} />
        <ContextStrip {...contextStripProps} mobileMetadataOnly={true} />
      </div>
    </div>
    <ProgressBar todos={todos} />
  </div>
);

const getTaskDocumentTitle = (taskInfo: React.ComponentProps<typeof TaskHeader>['taskInfo'], taskId?: string) => {
  if (taskInfo?.title) {
    return getCleanDocumentTitle(taskInfo.title, taskInfo.issueNumber);
  }

  return taskId ? `Task #${taskId}` : undefined;
};

const renderTaskDetailsStatus = (
  loading: boolean,
  error: string | null | undefined,
  history: ReturnType<typeof useTaskData>['history'],
  taskId?: string,
) => {
  if (loading) {
    return <CenteredStatus className="text-gray-600">Loading task details...</CenteredStatus>;
  }

  if (error) {
    return <CenteredStatus className="text-red-600">Error loading task details: {error}</CenteredStatus>;
  }

  if (!history || history.length === 0) {
    return <CenteredStatus className="text-gray-600">No history found for task {taskId}</CenteredStatus>;
  }

  return null;
};

const getMobileSummaryTitle = (title: string | undefined, taskId?: string) => {
  const firstLine = title?.split('\n')[0]?.trim();
  // The same sanitizer as the task list and the desktop heading.
  const firstLineTitle = sanitizeTaskTitle(firstLine).title ?? firstLine;

  if (firstLineTitle) {
    return firstLineTitle;
  }

  return taskId ? `Task #${taskId}` : '';
};

interface TaskDetailsProps {
  /** Wins over the `:taskId` route param, so the task list can show a task beside itself. */
  taskId?: string;
  /**
   * Shown in a pane beside the task list: the list owns the document title, a
   * delete closes the pane instead of navigating, and the timeline and output
   * stack in one column, because a pane is never wide enough for the split.
   */
  embedded?: boolean;
  onClose?: () => void;
  /** Called with the deleted task's ID, which may no longer be the task on screen. */
  onDeleted?: (taskId: string) => void;
  /**
   * Every run of this task, oldest first. With more than one, the timeline
   * lists them all and moves between them: the files changed and the
   * execution log follow the run chosen there.
   */
  runs?: TaskRunEntry[];
  /** Opens another run of this task in its place. */
  onSelectRun?: (taskId: string) => void;
  /** The pane's own controls, docked at the right of the header's first row. */
  paneControls?: React.ReactNode;
}

/** Drops a desktop-only (`lg:`) class list when the details sit in a pane. */
const wideOnly = (embedded: boolean, classes: string) => (embedded ? '' : ` ${classes}`);

const TaskDetails: React.FC<TaskDetailsProps> = ({ taskId: taskIdProp, embedded = false, onDeleted, runs, onSelectRun, paneControls }) => {
  const params = useParams();
  const taskId = taskIdProp ?? params.taskId;
  const navigate = useNavigate();
  const { addToast } = useToast();
  const taskData = useTaskData(taskId);
  const promptData = usePromptData();
  const logFilesData = useLogFilesData();
  const thinkingLog = useThinkingLog(taskData.liveDetails, taskData.history);

  const handleDeleteTask = useCallback(async () => {
    const deletedTaskId = taskId;
    const success = await taskData.handleDeleteTask();
    if (success && deletedTaskId) {
      addToast({
        type: 'success',
        message: 'Task deleted successfully',
      });
      if (embedded) onDeleted?.(deletedTaskId);
      else navigate('/tasks');
    }
  }, [taskId, taskData, navigate, addToast, embedded, onDeleted]);

  // Set document title with task info
  const documentTitle = getTaskDocumentTitle(taskData.taskInfo, taskId);
  useDocumentTitle(documentTitle, !embedded);

  const [highlightedTodoId, setHighlightedTodoId] = useState<string | null>(null);
  const [followupModalOpen, setFollowupModalOpen] = useState(false);

  const consumedReviewCommentIds = useConsumedReviewCommentIds(taskData.history);
  const tokenUsage = useTokenUsage(taskData.liveDetails, taskData.history);
  const ownSummary = useMemo(() => ({
    history: taskData.history,
    taskInfo: taskData.taskInfo,
    usageMetricRecords: taskData.usageMetricRecords,
    tokenUsage,
  }), [taskData.history, taskData.taskInfo, taskData.usageMetricRecords, tokenUsage]);
  const { headerProps, contextStripProps, runStripProps, runState, inspection, headerRun } = useTaskHeaderView(taskId, runs, ownSummary);
  const liveRun = useLiveRunStop(inspection?.head, Boolean(inspection?.headActive));

  const handleFollowupSubmit = useCallback(async (body: string) => {
    if (!taskId) {
      throw new Error('Task ID is required');
    }
    await postTaskFollowup(taskId, body);
    addToast({
      type: 'success',
      message: 'Follow-up comment posted successfully'
    });
  }, [taskId, addToast]);

  const handleOpenFollowup = useCallback(() => {
    setFollowupModalOpen(true);
  }, []);

  const executionLogRef = useClickOutsideCollapse(
    thinkingLog.eventsCollapsed,
    thinkingLog.collapseEvents,
  );

  const statusView = renderTaskDetailsStatus(
    taskData.loading,
    taskData.error,
    taskData.history,
    taskId,
  );

  if (statusView) {
    // The pane's controls live in the task's header; until there is one, they sit above the status.
    if (!paneControls) return statusView;
    return (
      <div className="flex h-full min-h-0 flex-col bg-white">
        <div className="flex flex-none justify-end gap-0.5 px-3 py-1.5">{paneControls}</div>
        <div className="min-h-0 flex-1">{statusView}</div>
      </div>
    );
  }

  const derivedData = getHistoryDerivedData(taskData.history, taskData.taskInfo);
  const mobileSummaryTitle = getMobileSummaryTitle(taskData.taskInfo?.title, taskId);
  // Opening an earlier run is local to the panels below: they name it, the timeline's header has the way back, and the header's run line follows it.
  const inspectionContext = inspection && onSelectRun ? {
    runNumber: inspection.run.number,
    runCount: inspection.head.number,
    status: derivedData.currentStatus,
    commandMode: taskData.taskInfo?.commandMode,
    headActive: inspection.headActive,
    onBack: () => onSelectRun(inspection.head.task.id),
  } : null;
  const actionBarProps = {
    currentStatus: derivedData.currentStatus,
    historyItemWithPaths: derivedData.historyItemWithPaths,
    stoppingExecution: taskData.stoppingExecution,
    stopFailed: taskData.stopFailed,
    deletingTask: taskData.deletingTask,
    onStopExecution: taskData.handleStopExecution,
    onViewPrompt: promptData.fetchPrompt,
    onViewLogs: logFilesData.fetchLogFilesData,
    onDeleteTask: handleDeleteTask,
    onFollowUp: handleOpenFollowup,
    liveRun,
  };

  return (
    <div data-testid="task-details" data-embedded={embedded || undefined} className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto bg-white sm:overflow-hidden">
      {/* Mobile title block scrolls away with the page */}
      <header className="sm:hidden flex-shrink-0 bg-white">
        <div className="px-3 py-2 border-b border-slate-100">
          <TaskHeader {...headerProps} />
        </div>
      </header>

      {/* Desktop sticky header shell; keep below global navigation overlays. */}
      <header className="hidden sm:block flex-shrink-0 sticky top-0 z-10 bg-white">
        <DesktopTaskHeader
          headerProps={headerProps}
          contextStripProps={contextStripProps}
          runStripProps={runStripProps}
          runState={runState}
          actionBarProps={actionBarProps}
          run={headerRun}
          paneControls={paneControls}
        />

        <ProgressBar todos={taskData.liveDetails.todos} />
      </header>

      <MobileStickySummary
        title={mobileSummaryTitle}
        contextStripProps={contextStripProps}
        actionBarProps={actionBarProps}
        todos={taskData.liveDetails.todos}
      />

      {/* Main Content Area - 30/70 Split */}
      <div className="flex flex-col min-w-0 sm:min-h-0 sm:flex-1 sm:overflow-hidden">
        {/* Header Row - TIMELINE and section label */}
        <div className={`flex-shrink-0 flex border-b border-slate-200 sm:hidden${wideOnly(embedded, 'lg:flex')}`}>
          <div className={`w-full flex-shrink-0 px-4 flex items-center justify-between gap-3${wideOnly(embedded, 'lg:w-[30%]')}`}>
            <div className={`py-2${wideOnly(embedded, 'lg:py-2.5')} text-xs font-bold uppercase tracking-widest text-slate-500`}>
              TIMELINE
            </div>
            {inspectionContext && <ReturnToRunButton {...inspectionContext} />}
          </div>
          <SectionLabelHeader
            commandMode={taskData.taskInfo?.commandMode}
            ultrafixCycle={taskData.taskInfo?.ultrafixCycle}
            inspection={inspectionContext}
            className={`hidden flex-1 px-4 items-center gap-3${wideOnly(embedded, 'lg:flex')}`}
          />
        </div>

        {/* Content Area */}
        <div
          data-testid="task-workspace-scroll"
          className={`scrollbar-stealth flex flex-col min-w-0 sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:overscroll-contain${wideOnly(embedded, 'lg:flex-row lg:overflow-hidden')}`}
        >
          {/* LEFT PANE (30%) */}
          <div
            data-testid="task-timeline-scroll"
            role="region"
            aria-label="Task timeline"
            className={`w-full min-w-0 flex-shrink-0 border-b border-gray-200 scrollbar-stealth${wideOnly(embedded, 'lg:min-h-0 lg:w-[30%] lg:overflow-y-auto lg:overscroll-contain lg:border-b-0 lg:border-r')}`}
          >
            <div className={`sticky top-0 z-[1] hidden items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 sm:flex${wideOnly(embedded, 'lg:hidden')}`}>
              <div className="py-2 text-xs font-bold uppercase tracking-widest text-slate-500">
                TIMELINE
              </div>
              {/* The way back from an earlier run sits where the run was opened. */}
              {inspectionContext && <ReturnToRunButton {...inspectionContext} />}
            </div>
            <LeftPaneBody
              history={taskData.history}
              taskInfo={taskData.taskInfo}
              liveDetails={taskData.liveDetails}
              currentStatus={derivedData.currentStatus}
              prInfo={derivedData.prInfo}
              consumedReviewCommentIds={consumedReviewCommentIds}
              taskId={taskId}
              isTaskActive={derivedData.isTaskActive}
              onTodoHover={setHighlightedTodoId}
              runs={runs}
              onSelectRun={onSelectRun}
            />
          </div>

          {/* RIGHT PANE (70%) */}
          <div className={`flex flex-col min-w-0${wideOnly(embedded, 'lg:flex-1 lg:min-h-0 lg:overflow-hidden')}`}>
            {/* Mobile section header */}
            <SectionLabelHeader
              commandMode={taskData.taskInfo?.commandMode}
              ultrafixCycle={taskData.taskInfo?.ultrafixCycle}
              inspection={inspectionContext}
              className={`flex flex-shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-2 sm:sticky sm:top-0 sm:z-[1] sm:bg-white${wideOnly(embedded, 'lg:hidden')}`}
            />
            {/* Scrollable Content Area - Summary + Thinking Log in same scroll flow */}
            {/* Remains visible when Execution Log is expanded so both logs can share vertical space */}
            <div className={`flex flex-col min-w-0${wideOnly(embedded, 'lg:flex-1 lg:min-h-0 lg:overflow-hidden')}`}>
              <div
                data-testid="task-output-scroll"
                role="region"
                aria-label="Task implementation log"
                className={`min-w-0 overflow-x-hidden scrollbar-stealth${wideOnly(embedded, 'lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain')}`}
              >
                <TaskVisualPreviews previews={taskData.previewMedia} />
                <ResultOverview extractedSummary={thinkingLog.extractedSummary} renderMarkdown={renderMarkdown} />

                <div className={`p-3 min-w-0 overflow-hidden${wideOnly(embedded, 'lg:p-4')}`}>
                  <ThinkingLog
                    events={thinkingLog.thinkingLogWithTimestamps}
                    todos={taskData.liveDetails.todos}
                    highlightedTodoId={highlightedTodoId}
                    historyTruncated={taskData.liveDetails.historyTruncated}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Execution Event Log Footer */}
      <div
        ref={executionLogRef}
        className={`flex-shrink-0 transition-all duration-300 ease-in-out min-w-0 overflow-hidden ${thinkingLog.eventsCollapsed ? '' : 'flex h-[clamp(12rem,42dvh,22rem)] max-h-[60dvh] min-h-0 flex-col' + wideOnly(embedded, 'lg:h-auto lg:max-h-[60%] lg:flex-1')}`}
      >
        <ExecutionEventLog
          events={taskData.liveDetails.events}
          omittedEventCount={taskData.liveDetails.omittedEventCount}
          historyTruncated={taskData.liveDetails.historyTruncated}
          collapsed={thinkingLog.eventsCollapsed}
          onToggleCollapse={thinkingLog.toggleEventsCollapse}
          lastThought={thinkingLog.lastThought}
          isTaskActive={derivedData.isTaskActive}
          taskInfo={taskData.taskInfo}
          runNumber={inspectionContext?.runNumber}
        />
      </div>

      {/* Modals */}
      <PromptModal
        prompt={promptData.selectedPrompt}
        loading={promptData.loadingPrompt}
        onClose={() => promptData.setSelectedPrompt(null)}
      />

      <LogFilesModal
        logFiles={logFilesData.logFiles}
        selectedLogFile={logFilesData.selectedLogFile}
        loadingLogFile={logFilesData.loadingLogFile}
        searchQuery={logFilesData.searchQuery}
        searchMatches={logFilesData.searchMatches}
        currentMatchIndex={logFilesData.currentMatchIndex}
        onClose={logFilesData.closeLogFiles}
        onSelectFile={logFilesData.fetchLogFile}
        onSearchChange={logFilesData.setSearchQuery}
        onPrevMatch={() => logFilesData.setCurrentMatchIndex((prev) => (prev - 1 + logFilesData.searchMatches.length) % logFilesData.searchMatches.length)}
        onNextMatch={() => logFilesData.setCurrentMatchIndex((prev) => (prev + 1) % logFilesData.searchMatches.length)}
        logContentRef={logFilesData.logContentRef}
      />

      <FollowupModal
        isOpen={followupModalOpen}
        onClose={() => setFollowupModalOpen(false)}
        onSubmit={handleFollowupSubmit}
        initialContent={'Please address the following based on the previous task execution:\n\n'}
        taskInfo={taskData.taskInfo}
      />
    </div>
  );
};

export default TaskDetails;
