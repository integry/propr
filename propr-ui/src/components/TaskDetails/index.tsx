import React, { useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { renderMarkdown } from './renderMarkdown';
import ThinkingLog from './ThinkingLog';
import ExecutionEventLog from './ExecutionEventLog';
import ResultOverview from './ResultOverview';
import { parseAnalysis } from './AnalysisUtils';
import { generateFollowupContent } from './utils';
import PromptModal from './PromptModal';
import LogFilesModal from './LogFilesModal';
import FollowupModal from './FollowupModal';
import ContextStrip from './ContextStrip';
import ActionBar from './ActionBar';
import TaskHeader from './TaskHeader';
import ProgressBar from './ProgressBar';
import LeftPaneBody from './LeftPaneBody';
import SectionLabelHeader from './SectionLabelHeader';
import { useTaskData, usePromptData, useLogFilesData } from './hooks';
import { useThinkingLog } from './useThinkingLog';
import { getHistoryDerivedData } from './useHistoryData';
import { getCleanDocumentTitle } from '../TaskList/utils.tsx';
import { useToast } from '../ui/useToast';
import { postTaskFollowup } from '../../api/proprApi';
import { useTotalDuration, useCommitInfo, useConsumedReviewCommentIds, useTokenUsage } from './useDerivedTaskData';
import { useClickOutsideCollapse } from './useClickOutsideCollapse';

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
  <div className="sm:hidden sticky top-0 z-20 bg-white">
    <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-200">
      <div className="flex flex-col gap-2">
        <div className="truncate text-xs font-semibold text-slate-700">{title}</div>
        <div className="flex items-center justify-between gap-2">
          <ContextStrip {...contextStripProps} mobileRepoOnly={true} />
          <ActionBar {...actionBarProps} />
        </div>
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
  const firstLineTitle = title?.split('\n')[0]?.trim();

  if (firstLineTitle) {
    return firstLineTitle;
  }

  return taskId ? `Task #${taskId}` : '';
};

const TaskDetails: React.FC = () => {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const taskData = useTaskData(taskId);
  const promptData = usePromptData();
  const logFilesData = useLogFilesData();
  const thinkingLog = useThinkingLog(taskData.liveDetails, taskData.history);

  const handleDeleteTask = useCallback(async () => {
    const success = await taskData.handleDeleteTask();
    if (success) {
      addToast({
        type: 'success',
        message: 'Task deleted successfully',
      });
      navigate('/tasks');
    }
  }, [taskData, navigate, addToast]);

  // Set document title with task info
  const documentTitle = getTaskDocumentTitle(taskData.taskInfo, taskId);
  useDocumentTitle(documentTitle);

  const [highlightedTodoId, setHighlightedTodoId] = useState<string | null>(null);
  const [followupModalOpen, setFollowupModalOpen] = useState(false);
  const [detailedAnalysisExpanded, setDetailedAnalysisExpanded] = useState<boolean | undefined>(undefined);

  const totalDuration = useTotalDuration(taskData.history);
  const commitInfo = useCommitInfo(taskData.history, taskData.taskInfo);
  const consumedReviewCommentIds = useConsumedReviewCommentIds(taskData.history);
  const tokenUsage = useTokenUsage(taskData.liveDetails, taskData.history);

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

  const parsedAnalysis = useMemo(() => parseAnalysis(taskData.analysis), [taskData.analysis]);

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
    return statusView;
  }

  const derivedData = getHistoryDerivedData(taskData.history, taskData.taskInfo);
  const score = parsedAnalysis?.implementation_critique_score;
  const mobileSummaryTitle = getMobileSummaryTitle(taskData.taskInfo?.title, taskId);
  const headerProps = {
    taskInfo: taskData.taskInfo,
    currentStatus: derivedData.currentStatus,
  };
  const contextStripProps = {
    taskInfo: taskData.taskInfo,
    modelName: derivedData.modelName,
    prInfo: derivedData.prInfo,
    commitInfo,
    duration: totalDuration,
    tokenUsage,
    usageMetricRecords: taskData.usageMetricRecords,
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
  };

  return (
    <div className="min-h-full flex flex-col overflow-x-hidden bg-white sm:h-full sm:overflow-hidden">
      {/* Mobile title block scrolls away with the page */}
      <header className="sm:hidden flex-shrink-0 bg-white">
        <div className="px-3 py-2 border-b border-slate-100">
          <TaskHeader {...headerProps} />
        </div>
      </header>

      {/* Desktop sticky header shell */}
      <header className="hidden sm:block flex-shrink-0 sticky top-0 z-20 bg-white">
        <div className="px-6 py-3 border-b border-slate-100">
          <TaskHeader {...headerProps} />
        </div>

        <div className="px-6 py-2 bg-slate-50 border-b border-slate-200">
          <div className="flex items-center justify-between gap-4">
            <ContextStrip {...contextStripProps} />
            <ActionBar {...actionBarProps} />
          </div>
        </div>

        <ProgressBar todos={taskData.liveDetails.todos} />
      </header>

      <MobileStickySummary
        title={mobileSummaryTitle}
        contextStripProps={contextStripProps}
        actionBarProps={actionBarProps}
        todos={taskData.liveDetails.todos}
      />

      {/* Main Content Area - 30/70 Split */}
      <div className="flex flex-col min-w-0 sm:flex-1 sm:overflow-hidden">
        {/* Header Row - TIMELINE and section label */}
        <div className="flex-shrink-0 flex border-b border-slate-200">
          <div className="w-full lg:w-[30%] flex-shrink-0 px-4 flex items-center">
            <div className="py-2 lg:py-2.5 text-xs font-bold uppercase tracking-widest text-slate-500">
              TIMELINE
            </div>
          </div>
          <SectionLabelHeader
            commandMode={taskData.taskInfo?.commandMode}
            score={score}
            ultrafixCycle={taskData.taskInfo?.ultrafixCycle}
            className="hidden lg:flex flex-1 px-4 items-center gap-3"
          />
        </div>

        {/* Content Area */}
        <div className="flex flex-col min-w-0 sm:flex-1 lg:flex-row lg:overflow-hidden">
          {/* LEFT PANE (30%) */}
          <div className="w-full lg:w-[30%] flex-shrink-0 lg:overflow-y-auto scrollbar-stealth border-b lg:border-b-0 lg:border-r border-gray-200">
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
            />
          </div>

          <div className="hidden lg:block w-px bg-gray-200 flex-shrink-0" />

          {/* RIGHT PANE (70%) */}
          <div className="flex flex-col min-w-0 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
            {/* Mobile section header */}
            <SectionLabelHeader
              commandMode={taskData.taskInfo?.commandMode}
              score={score}
              ultrafixCycle={taskData.taskInfo?.ultrafixCycle}
              className="lg:hidden flex-shrink-0 px-4 py-2 border-b border-slate-200 flex items-center gap-3"
            />
            {/* Scrollable Content Area - Implementation Analysis + Thinking Log in same scroll flow */}
            {/* Remains visible when Execution Log is expanded so both logs can share vertical space */}
            <div className="flex flex-col min-w-0 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
              <div className="min-w-0 overflow-x-hidden scrollbar-stealth lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
                {(taskData.analysis || taskData.analysisLoading || thinkingLog.extractedSummary) && (
                  <ResultOverview
                    analysis={taskData.analysis}
                    loading={taskData.analysisLoading}
                    renderMarkdown={renderMarkdown}
                    detailedAnalysisExpanded={detailedAnalysisExpanded}
                    onDetailedAnalysisToggle={setDetailedAnalysisExpanded}
                    extractedSummary={thinkingLog.extractedSummary}
                  />
                )}

                <div className="p-3 lg:p-4 min-w-0 overflow-hidden">
                  <ThinkingLog
                    events={thinkingLog.thinkingLogWithTimestamps}
                    todos={taskData.liveDetails.todos}
                    highlightedTodoId={highlightedTodoId}
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
        className={`flex-shrink-0 transition-all duration-300 ease-in-out min-w-0 overflow-hidden ${thinkingLog.eventsCollapsed ? '' : 'max-h-[100vh] lg:flex-1 lg:flex lg:flex-col lg:min-h-0 lg:max-h-[60vh]'}`}
      >
        <ExecutionEventLog
          events={taskData.liveDetails.events}
          collapsed={thinkingLog.eventsCollapsed}
          onToggleCollapse={thinkingLog.toggleEventsCollapse}
          lastThought={thinkingLog.lastThought}
          isTaskActive={derivedData.isTaskActive}
          taskInfo={taskData.taskInfo}
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
        initialContent={generateFollowupContent(taskData.analysis, taskData.history)}
        taskInfo={taskData.taskInfo}
      />
    </div>
  );
};

export default TaskDetails;
