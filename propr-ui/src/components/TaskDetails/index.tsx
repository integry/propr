import React, { useState, useCallback, useMemo, useEffect } from 'react';
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
import SectionLabelHeader, { EXECUTION_LOG_CONTROL_ATTRIBUTE, type LogView } from './SectionLabelHeader';
import TaskVisualPreviews from './TaskVisualPreviews';
import { useTaskData, usePromptData, useLogFilesData } from './hooks';
import { useThinkingLog } from './useThinkingLog';
import { getHistoryDerivedData } from './useHistoryData';
import { getCleanDocumentTitle } from '../TaskList/utils.tsx';
import { useToast } from '../ui/useToast';
import { postTaskFollowup } from '../../api/proprApi';
import { useConsumedReviewCommentIds, useTokenUsage } from './useDerivedTaskData';
import { useClickOutsideCollapse } from './useClickOutsideCollapse';
import { isReviewRun, type TaskRunEntry } from '../TaskList/rowModel';
import DesktopTaskHeader from './DesktopTaskHeader';
import { useTaskHeaderView } from './useTaskHeaderView';
import { useLiveRunStop } from './useLiveRunStop';
import { useTaskAssignment } from './useTaskAssignment';

const CenteredStatus: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <div className="h-full bg-white flex items-center justify-center">
    <div className={className}>{children}</div>
  </div>
);

type MobileHeaderProps = {
  contextStripProps: React.ComponentProps<typeof ContextStrip>;
  actionBarProps: React.ComponentProps<typeof ActionBar>;
  todos: React.ComponentProps<typeof ProgressBar>['todos'];
};

/** The full mobile summary scrolls away with the title; the compact bar stands in for it once it's gone. */
const MobileSummary = React.forwardRef<HTMLDivElement, MobileHeaderProps>(({ contextStripProps, actionBarProps, todos }, ref) => (
  <div ref={ref} className="sm:hidden flex-shrink-0 bg-white">
    <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-200">
      {/* The title block above already names the task; repeating it here stacked the title twice. */}
      <div className="flex flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ContextStrip {...contextStripProps} mobileRepoOnly={true} />
        </div>
        <ActionBar {...actionBarProps} sheet={true} />
        <ContextStrip {...contextStripProps} mobileMetadataOnly={true} />
      </div>
    </div>
    <ProgressBar todos={todos} />
  </div>
));
MobileSummary.displayName = 'MobileSummary';

/** Height of the compact bar; sections pin their own headers just below it. */
const MOBILE_COMPACT_BAR_HEIGHT = 44;

/**
 * One fixed-height line: the pull request and the task's title on the left,
 * the overflow (and Stop, while the task works) on the right; the overflow
 * opens as a bottom action sheet. The sticky
 * wrapper takes no height, so showing the bar never reflows the page under it.
 */
const MobileCompactBar: React.FC<MobileHeaderProps & { visible: boolean }> = ({ contextStripProps, actionBarProps, todos, visible }) => (
  // Page-local sticky UI should sit below the global header dropdown stacking
  // context while remaining sticky within the task details route.
  <div className="sm:hidden sticky top-0 z-20 h-0">
    <div
      data-testid="task-mobile-compact-bar"
      aria-hidden={!visible}
      inert={!visible}
      className={`absolute inset-x-0 top-0 border-b border-slate-200 bg-white shadow-sm transition-opacity duration-150 ${visible ? 'opacity-100' : 'invisible opacity-0'}`}
    >
      <div className="flex items-center justify-between gap-2 px-3" style={{ height: MOBILE_COMPACT_BAR_HEIGHT - 1 }}>
        {/* Only the left side clips, so the 44px overflow button keeps its full touch target. */}
        <div className="flex h-full min-w-0 flex-1 items-center overflow-hidden">
          <ContextStrip {...contextStripProps} mobileCompact={true} />
        </div>
        <ActionBar {...actionBarProps} compact={true} />
      </div>
      <ProgressBar todos={todos} />
    </div>
  </div>
);

/** Whether the full mobile summary has scrolled up under the compact bar. */
const useMobileHeaderCollapsed = () => {
  const [summary, setSummary] = useState<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const root = summary?.closest<HTMLElement>('[data-testid="task-details"]');
    if (!summary || !root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      const top = entry.rootBounds?.top ?? 0;
      setCollapsed(!entry.isIntersecting && entry.boundingClientRect.bottom <= top + 1);
    }, { root, rootMargin: `-${MOBILE_COMPACT_BAR_HEIGHT}px 0px 0px 0px` });
    observer.observe(summary);
    return () => observer.disconnect();
  }, [summary]);
  return { summaryRef: setSummary, collapsed };
};

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

/** The run's kind for its log's header; the run list knows a review by its type even when the task's own record doesn't say. */
const getLogCommandMode = (commandMode: string | undefined, runs: TaskRunEntry[] | undefined, taskId: string | undefined) => {
  if (commandMode === 'review' || isReviewRun(runs?.find(run => run.task.id === taskId)?.type)) return 'review';
  return commandMode;
};

/** The timeline's and the trace's headers share a height, so their rules line up side by side. */
const PANE_HEADER_HEIGHT = 'min-h-[2.75rem]';

/** What the trace says when a run recorded no steps, rather than leaving the column blank. */
const getEmptyTraceMessage = (isActive: boolean, status: string) => {
  if (isActive) return 'Waiting for the agent’s first step…';
  return status?.toUpperCase() === 'COMPLETED'
    ? 'No execution logs recorded — task completed directly.'
    : 'No execution logs recorded for this run.';
};

/** Drops a desktop-only (`lg:`) class list when the details sit in a pane. */
const wideOnly = (embedded: boolean, classes: string) => (embedded ? '' : ` ${classes}`);

/** The timeline pane's title, counting the runs when there is more than one. */
const TimelineHeading: React.FC<{ runCount: number }> = ({ runCount }) => (
  <div className="py-2 text-xs font-bold uppercase tracking-widest text-slate-500">
    TIMELINE
    {runCount > 1 && (
      <>
        {' '}
        <span data-testid="timeline-run-count" className="ml-1.5 font-mono font-normal normal-case tracking-normal">({runCount} runs)</span>
      </>
    )}
  </div>
);

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
    budget: taskData.budget,
  }), [taskData.history, taskData.taskInfo, taskData.usageMetricRecords, tokenUsage, taskData.budget]);
  const { headerProps, contextStripProps, runStripProps, runState, inspection, headerRun } = useTaskHeaderView(taskId, runs, ownSummary);
  const liveRun = useLiveRunStop(inspection?.head, Boolean(inspection?.headActive));
  // One read serves the desktop header and the mobile summary; the compact bar never shows it.
  const assignment = useTaskAssignment(taskId);
  const assignedStripProps = { ...contextStripProps, assignment };

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

  const mobileHeader = useMobileHeaderCollapsed();

  const executionLogRef = useClickOutsideCollapse(
    thinkingLog.eventsCollapsed,
    thinkingLog.collapseEvents,
    EXECUTION_LOG_CONTROL_ATTRIBUTE,
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
  // Opening an earlier run is local to the panels below: they name it, the timeline's header has the way back, and the header's run line follows it.
  const inspectionContext = inspection && onSelectRun ? {
    runNumber: inspection.run.number,
    runCount: inspection.head.number,
    status: derivedData.currentStatus,
    commandMode: taskData.taskInfo?.commandMode,
    headActive: inspection.headActive,
    onBack: () => onSelectRun(inspection.head.task.id),
  } : null;
  // One header names the log, counts its steps and switches to the raw terminal drawer below.
  const logHeaderProps = {
    commandMode: getLogCommandMode(taskData.taskInfo?.commandMode, runs, taskId),
    ultrafixCycle: taskData.taskInfo?.ultrafixCycle,
    inspection: inspectionContext,
    stepCount: thinkingLog.thinkingLogWithTimestamps.length,
    view: (thinkingLog.eventsCollapsed ? 'readable' : 'terminal') as LogView,
    onViewChange: (view: LogView) => (view === 'terminal' ? thinkingLog.expandEvents() : thinkingLog.collapseEvents()),
  };
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
    <div data-testid="task-details" data-embedded={embedded || undefined} className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto bg-white pb-24 sm:overflow-hidden sm:pb-0">
      <MobileCompactBar
        contextStripProps={contextStripProps}
        actionBarProps={actionBarProps}
        todos={taskData.liveDetails.todos}
        visible={mobileHeader.collapsed}
      />

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
          contextStripProps={assignedStripProps}
          runStripProps={runStripProps}
          runState={runState}
          actionBarProps={actionBarProps}
          run={headerRun}
          paneControls={paneControls}
          breadcrumb={!embedded}
        />

        <ProgressBar todos={taskData.liveDetails.todos} />
      </header>

      <MobileSummary
        ref={mobileHeader.summaryRef}
        contextStripProps={assignedStripProps}
        actionBarProps={actionBarProps}
        todos={taskData.liveDetails.todos}
      />

      {/* Main Content Area - 30/70 Split */}
      <div className="flex flex-col min-w-0 sm:min-h-0 sm:flex-1 sm:overflow-hidden">
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
            <div className={`z-[1] flex ${PANE_HEADER_HEIGHT} items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 sm:sticky sm:top-0`}>
              <TimelineHeading runCount={runs?.length ?? 0} />
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

          {/* RIGHT PANE (70%): the run's deliverables first, then the trace of how it got there. */}
          <div className={`flex flex-col min-w-0${wideOnly(embedded, 'lg:flex-1 lg:min-h-0 lg:overflow-hidden')}`}>
            <div
              data-testid="task-output-scroll"
              role="region"
              aria-label="Task implementation log"
              className={`min-w-0 overflow-x-clip scrollbar-stealth${wideOnly(embedded, 'lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain')}`}
            >
              {/* Visual evidence is an outcome with its own header; its bottom rule divides it from the trace. */}
              <TaskVisualPreviews previews={taskData.previewMedia} />
              {/* The trace's header stays with its logs, so its view switch sits above what it controls. */}
              <SectionLabelHeader
                {...logHeaderProps}
                className={`z-[1] flex ${PANE_HEADER_HEIGHT} flex-shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:sticky sm:top-0`}
              />
              <ResultOverview extractedSummary={thinkingLog.extractedSummary} renderMarkdown={renderMarkdown} />

              <div className={`p-3 min-w-0 overflow-hidden${wideOnly(embedded, 'lg:p-4')}`}>
                <ThinkingLog
                  events={thinkingLog.thinkingLogWithTimestamps}
                  todos={taskData.liveDetails.todos}
                  highlightedTodoId={highlightedTodoId}
                  streaming={derivedData.isTaskActive}
                  historyTruncated={taskData.liveDetails.historyTruncated}
                  emptyMessage={getEmptyTraceMessage(derivedData.isTaskActive, derivedData.currentStatus)}
                />
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
