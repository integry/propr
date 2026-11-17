import React, { useState, useCallback, useMemo, useEffect } from 'react';
import type { RunRevealHistory } from './RunTimeline';
import { useParams, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { NOT_FOUND_TITLE } from '../NotFound';
import { isTaskNotFound, renderTaskDetailsStatus } from './TaskDetailsStatus';
import { renderMarkdown } from './renderMarkdown';
import ThinkingLog from './ThinkingLog';
import ExecutionEventLog from './ExecutionEventLog';
import ResultOverview from './ResultOverview';
import PromptModal from './PromptModal';
import LogFilesModal from './LogFilesModal';
import FollowupModal from './FollowupModal';
import { ConsumptionGroup, MobileGitContext, MobilePeopleRuntime } from './ContextStrip';
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
import { useConsumedReviewCommentIds, useTokenUsage } from './useDerivedTaskData';
import { useClickOutsideCollapse } from './useClickOutsideCollapse';
import type { TaskRunEntry } from '../TaskList/rowModel';
import DesktopTaskHeader from './DesktopTaskHeader';
import { getLogCommandMode, useTaskHeaderView } from './useTaskHeaderView';
import { useLiveRunStop } from './useLiveRunStop';
import { useTaskAssignment } from './useTaskAssignment';
import LatestRunCommands from './LatestRunCommands';
import { useTaskPullRequestScores } from './pullRequestScores';
import { followupTargetFor, getEmptyTraceMessage, hasFollowupTarget, isAutomationReportTask, taskLabelMode } from './taskKind';
import { useTaskFollowup } from './useTaskFollowup';
import FollowupHandoffBanner from './FollowupHandoffBanner';
import { CompactHeaderLine, MOBILE_COMPACT_BAR_HEIGHT, ShortTaskHeader, type MobileHeaderProps } from './CompactTaskHeader';
import { SHORT_DETAILS, SHORT_LOG_BAR, SHORT_OPEN_LOG, SHORT_MEASURE_ONLY, SHORT_UNBOUNDED, useShortWorkspace } from './useShortWorkspace';



/** The full mobile summary scrolls away with the title; the compact bar stands in for it once it's gone. */
const MobileSummary = React.forwardRef<HTMLDivElement, MobileHeaderProps>(({ contextStripProps, actionBarProps, todos }, ref) => (
  <div ref={ref} className="sm:hidden flex-shrink-0 bg-white">
    <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-200">
      {/* The title block above already names the task; repeating it here stacked the title twice. */}
      <div data-testid="task-mobile-metadata" className="flex flex-col gap-1">
        {/* The actions wrap below the Git links rather than squeezing the PR badge under them. */}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-1 gap-y-1">
          <MobileGitContext {...contextStripProps} />
          <ActionBar {...actionBarProps} mobileSummary />
        </div>
        <MobilePeopleRuntime {...contextStripProps} />
        <ConsumptionGroup {...contextStripProps} />
      </div>
    </div>
    <ProgressBar todos={todos} />
  </div>
));
MobileSummary.displayName = 'MobileSummary';



/**
 * The phone's compact line, shown once the full summary scrolls away. The sticky
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
      <CompactHeaderLine contextStripProps={contextStripProps} actionBarProps={actionBarProps} />
      <ProgressBar todos={todos} />
    </div>
  </div>
);


/** Whether the full mobile summary has scrolled up under the compact bar. */
const useMobileHeaderCollapsed = () => {
  const [summary, setSummary] = useState<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const root = summary?.closest<HTMLElement>('[data-scroll-lock-target]');
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

const getTaskDocumentTitle = (taskInfo: React.ComponentProps<typeof TaskHeader>['taskInfo'], taskId: string | undefined, notFound: boolean) => {
  if (notFound) return NOT_FOUND_TITLE;
  if (taskInfo?.title) return getCleanDocumentTitle(taskInfo.title, taskInfo.issueNumber);

  return taskId ? `Task #${taskId}` : undefined;
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
  revealHistory?: RunRevealHistory;
  /** Opens another run of this task in its place. */
  onSelectRun?: (taskId: string) => void;
  /** The pane's own controls, docked at the right of the header's first row. */
  paneControls?: React.ReactNode;
}

/** The timeline's and the trace's headers share a height, so their rules line up side by side. */
const PANE_HEADER_HEIGHT = 'min-h-[2.75rem]';

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

/** Pin timelines that fit; taller ones must scroll freely to keep every run reachable. */
const observeTimeline = (node: HTMLDivElement | null) => {
  const scroller = node?.parentElement;
  if (!node || !scroller || typeof ResizeObserver === 'undefined') return;
  const update = () => {
    // A short window scrolls the whole task, which has no room to pin a pane in.
    if (node.closest('[data-short-workspace]')) { node.style.setProperty('--timeline-position', 'static'); return; }
    // Streaming steps must not relocate the timeline while the reader is mid-scroll.
    if (scroller.scrollTop !== 0) return;
    node.style.setProperty('--timeline-position', node.offsetHeight <= scroller.clientHeight ? 'sticky' : 'static');
  };
  const observer = new ResizeObserver(update);
  for (const target of [node, scroller]) observer.observe(target);
  update();
  scroller.addEventListener('scroll', update, { passive: true });
  // Ref callback cleanup requires the React 19 version pinned by propr-ui.
  return () => {
    observer.disconnect();
    scroller.removeEventListener('scroll', update);
  };
};

const TaskDetails: React.FC<TaskDetailsProps> = ({ taskId: taskIdProp, embedded = false, onDeleted, runs, revealHistory, onSelectRun, paneControls }) => {
  const params = useParams();
  const taskId = taskIdProp ?? params.taskId;
  const navigate = useNavigate();
  const { addToast } = useToast();
  const rawTaskData = useTaskData(taskId);
  const commandMode = getLogCommandMode(rawTaskData.taskInfo?.commandMode, runs, taskId);
  const taskData = useMemo(() => commandMode === 'review' && rawTaskData.taskInfo
    ? { ...rawTaskData, taskInfo: { ...rawTaskData.taskInfo, commandMode: 'review' as const } }
    : rawTaskData, [rawTaskData, commandMode]);
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

  const notFound = isTaskNotFound(taskData.loading, taskData.error, taskData.history);
  // Set document title with task info
  const documentTitle = getTaskDocumentTitle(taskData.taskInfo, taskId, notFound);
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
  const assignedStripProps = useMemo(() => ({ ...contextStripProps, assignment }), [contextStripProps, assignment]);

  const followup = useTaskFollowup(taskId);

  const handleOpenFollowup = useCallback(() => setFollowupModalOpen(true), []);

  const mobileHeader = useMobileHeaderCollapsed();
  const shortWorkspace = useShortWorkspace();

  const executionLogRef = useClickOutsideCollapse(thinkingLog.eventsCollapsed, thinkingLog.collapseEvents);

  const derivedData = getHistoryDerivedData(taskData.history, taskData.taskInfo);
  const pullRequest = useTaskPullRequestScores(taskData.taskInfo, derivedData.prInfo, runs);

  const statusView = renderTaskDetailsStatus(taskData.loading, taskData.error, notFound);

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

  // Opening an earlier run is local to the panels below: they name it, the timeline's header has the way back, and the header's run line follows it.
  const inspectionContext = inspection && onSelectRun ? {
    runNumber: inspection.run.number,
    runCount: inspection.head.number,
    status: derivedData.currentStatus,
    commandMode: taskLabelMode(taskData.taskInfo),
    headActive: inspection.headActive,
    onBack: () => onSelectRun(inspection.head.task.id),
  } : null;
  // One header names the log, counts its steps and identifies the inspected run.
  const logHeaderProps = {
    commandMode: getLogCommandMode(taskData.taskInfo?.commandMode, runs, taskId),
    ultrafixCycle: taskData.taskInfo?.ultrafixCycle,
    inspection: inspectionContext,
    stepCount: thinkingLog.thinkingLogWithTimestamps.length,
  };
  const actionBarProps = {
    currentStatus: derivedData.currentStatus,
    historyItemWithPaths: derivedData.historyItemWithPaths,
    stoppingExecution: taskData.stoppingExecution,
    stopFailed: taskData.stopFailed,
    deletingTask: taskData.deletingTask,
    onStopExecution: taskData.handleStopExecution,
    // One viewer at a time: opening either closes the other and abandons its pending request.
    onViewPrompt: (promptPath: string) => { logFilesData.closeLogFiles(); void promptData.fetchPrompt(promptPath); },
    onViewLogs: (logsPath: string) => { promptData.closePrompt(); void logFilesData.fetchLogFilesData(logsPath); },
    onDeleteTask: handleDeleteTask,
    // A merged pull request takes no more follow-ups, so none are offered until the PR is known to be unmerged.
    // A task with no issue or pull request (an automation run's) has no thread to comment on.
    ...(pullRequest.merged !== false || !hasFollowupTarget(taskData.taskInfo, derivedData.prInfo) ? {} : { followupCommands: <LatestRunCommands runs={runs} taskId={taskId} />, onFollowUp: handleOpenFollowup }),
    liveRun,
  };

  return (
    // Too short for the workspace under the header, the task scrolls as one page (as on a phone) above the pinned log bar.
    <div
      {...shortWorkspace.detailsProps}
      data-scroll-lock-target data-testid="task-details" data-embedded={embedded || undefined}
      className={`group/task h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto bg-white pb-24 sm:overflow-hidden sm:pb-0 ${SHORT_DETAILS}`}
    >
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

      {/* A short window (a phone in landscape) opens on the one-line compact header, leaving the room to the timeline. */}
      <ShortTaskHeader
        visible={shortWorkspace.short}
        contextStripProps={contextStripProps}
        actionBarProps={actionBarProps}
        todos={taskData.liveDetails.todos}
        paneControls={paneControls}
      />

      {/* Desktop sticky header shell; keep below global navigation overlays. */}
      <header {...shortWorkspace.headerProps} className={`hidden sm:block flex-shrink-0 sticky top-0 z-10 bg-white ${SHORT_MEASURE_ONLY}`}>
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

      <FollowupHandoffBanner handoff={followup.handoff} onSelectRun={onSelectRun} onDismiss={followup.dismiss} />

      {/* Split only when the 576px timeline and at least 384px of output fit.
          A grid row grows to the taller pane so both columns share the full scrollable height. */}
      <div className={`flex flex-col min-w-0 sm:min-h-0 sm:flex-1 sm:overflow-hidden [container:task-workspace/inline-size] ${SHORT_UNBOUNDED}`}>
        <div
          data-testid="task-workspace-scroll"
          className={`scrollbar-stealth flex flex-col min-w-0 sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:overscroll-contain ${SHORT_UNBOUNDED}${wideOnly(embedded, '[@container_task-workspace_(min-width:960px)]:grid [@container_task-workspace_(min-width:960px)]:grid-cols-[max(30%,576px)_minmax(0,1fr)]')}`}
        >
          {/* Keep 528px for step columns after pane padding, scrollbar and border. */}
          <div
            ref={observeTimeline} data-testid="task-timeline-scroll"
            role="region"
            aria-label="Task timeline"
            className={`w-full min-w-0 flex-shrink-0 border-b border-gray-200${wideOnly(embedded, '[@container_task-workspace_(min-width:960px)]:[position:var(--timeline-position,static)] [@container_task-workspace_(min-width:960px)]:top-0 [@container_task-workspace_(min-width:960px)]:self-start [@container_task-workspace_(min-width:960px)]:border-b-0')}`}
          >
            <div data-testid="task-timeline-heading" className={`z-[1] flex ${PANE_HEADER_HEIGHT} items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 sm:sticky sm:top-0`}>
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
              prHistory={pullRequest.history}
              consumedReviewCommentIds={consumedReviewCommentIds}
              taskId={taskId}
              isTaskActive={derivedData.isTaskActive}
              onTodoHover={setHighlightedTodoId}
              runs={runs}
              revealHistory={revealHistory}
              onSelectRun={onSelectRun}
            />
          </div>

          {/* RIGHT PANE: the run's deliverables first, then the trace of how it got there. */}
          <div data-testid="task-result-pane" className={`flex flex-col min-w-0 border-gray-200${wideOnly(embedded, '[@container_task-workspace_(min-width:960px)]:border-l')}`}>
            <div
              data-testid="task-output-scroll"
              role="region"
              aria-label="Task implementation log"
              className="min-w-0 overflow-x-clip"
            >
              {/* Visual evidence is an outcome with its own header; its bottom rule divides it from the trace. */}
              <TaskVisualPreviews previews={taskData.previewMedia} />
              {/* The trace's header stays with its logs. */}
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
                  emptyMessage={getEmptyTraceMessage(derivedData.isTaskActive, derivedData.currentStatus, isAutomationReportTask(taskData.taskInfo))}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Execution Event Log Footer */}
      <div
        ref={executionLogRef}
        className={`flex-shrink-0 transition-all duration-300 ease-in-out min-w-0 overflow-hidden ${SHORT_LOG_BAR} ${thinkingLog.eventsCollapsed ? '' : `flex h-[clamp(12rem,42dvh,22rem)] max-h-[60dvh] min-h-0 flex-col ${SHORT_OPEN_LOG}` + wideOnly(embedded, 'lg:h-auto lg:max-h-[60%] lg:flex-1')}`}
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
        onClose={promptData.closePrompt}
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
        onSubmit={followup.submit}
        initialContent={'Please address the following based on the previous task execution:\n\n'}
        target={followupTargetFor(taskData.taskInfo, taskId)}
      />
    </div>
  );
};

export default TaskDetails;
