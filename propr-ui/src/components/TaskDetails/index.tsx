import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { renderMarkdown } from './renderMarkdown';
import TaskStatusTable from './TaskStatusTable';
import ExecutionRail from './ExecutionRail';
import LiveFileChips from './LiveFileChips';
import ThinkingLog from './ThinkingLog';
import ExecutionEventLog from './ExecutionEventLog';
import ResultOverview, { GeometricScorePill } from './ResultOverview';
import { parseAnalysis } from './AnalysisUtils';
import { generateFollowupContent } from './utils';
import PromptModal from './PromptModal';
import LogFilesModal from './LogFilesModal';
import FollowupModal from './FollowupModal';
import ContextStrip from './ContextStrip';
import ActionBar from './ActionBar';
import TaskHeader from './TaskHeader';
import ProgressBar from './ProgressBar';
import { useTaskData, usePromptData, useLogFilesData } from './hooks';
import { useThinkingLog } from './useThinkingLog';
import { getHistoryDerivedData } from './useHistoryData';
import { getCleanDocumentTitle } from '../TaskList/utils.tsx';
import { useToast } from '../ui/useToast';
import { postTaskFollowup } from '../../api/proprApi';

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

  // Set document title with task info - use clean title format (e.g., "870: Title here")
  const documentTitle = taskData.taskInfo?.title
    ? getCleanDocumentTitle(taskData.taskInfo.title, taskData.taskInfo.issueNumber)
    : taskId ? `Task #${taskId}` : undefined;
  useDocumentTitle(documentTitle);

  // State for bi-directional highlighting between TodoList and ThinkingLog
  const [highlightedTodoId, setHighlightedTodoId] = useState<string | null>(null);

  // State for follow-up modal
  const [followupModalOpen, setFollowupModalOpen] = useState(false);


  // State for detailed analysis expansion (lifted from ResultOverview to persist across Execution Log toggles)
  // Now using CSS hidden instead of conditional rendering, so components don't unmount
  const [detailedAnalysisExpanded, setDetailedAnalysisExpanded] = useState<boolean | undefined>(undefined);

  // Calculate total duration from history
  const totalDuration = useMemo(() => {
    if (!taskData.history || taskData.history.length === 0) return null;
    const firstTimestamp = taskData.history[0]?.timestamp;
    const lastTimestamp = taskData.history[taskData.history.length - 1]?.timestamp;
    if (!firstTimestamp || !lastTimestamp) return null;
    return new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime();
  }, [taskData.history]);

  // Extract commit info from history metadata
  const commitInfo = useMemo(() => {
    if (!taskData.history || taskData.history.length === 0 || !taskData.taskInfo) return undefined;

    // Find history item with commitResult
    const historyWithCommit = taskData.history.find(
      item => item.metadata?.commitResult?.commitHash
    );

    if (!historyWithCommit?.metadata?.commitResult?.commitHash) return undefined;

    const commitHash = historyWithCommit.metadata.commitResult.commitHash;
    const shortHash = commitHash.substring(0, 7);
    const { repoOwner, repoName } = taskData.taskInfo;

    if (!repoOwner || !repoName) return undefined;

    const url = `https://github.com/${repoOwner}/${repoName}/commit/${commitHash}`;

    return { shortHash, url };
  }, [taskData.history, taskData.taskInfo]);

  // Extract token usage - prefer live details for active tasks, otherwise from history
  const tokenUsage = useMemo(() => {
    // First check live details (for active tasks)
    if (taskData.liveDetails?.tokenUsage) {
      return taskData.liveDetails.tokenUsage;
    }

    // Fall back to history metadata (for completed tasks)
    if (!taskData.history || taskData.history.length === 0) return undefined;

    // Find history item with tokenUsage in metadata
    const historyWithTokens = taskData.history.find(
      item => item.metadata?.tokenUsage
    );

    return historyWithTokens?.metadata?.tokenUsage;
  }, [taskData.liveDetails, taskData.history]);

  // Handle follow-up submission
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

  // Handle opening follow-up modal
  const handleOpenFollowup = useCallback(() => {
    setFollowupModalOpen(true);
  }, []);

  const parsedAnalysis = useMemo(() => parseAnalysis(taskData.analysis), [taskData.analysis]);

  // Ref for execution log section to detect clicks outside
  const executionLogRef = useRef<HTMLDivElement>(null);

  // Click-outside-to-collapse handler for Execution Log
  useEffect(() => {
    if (thinkingLog.eventsCollapsed) return; // Only listen when expanded

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      // Check if click is outside the execution log section
      if (executionLogRef.current && !executionLogRef.current.contains(target)) {
        thinkingLog.collapseEvents();
      }
    };

    // Add listener after a small delay to prevent immediate collapse from the click that opened it
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [thinkingLog]);

  if (taskData.loading) {
    return (
      <div className="h-full bg-white flex items-center justify-center">
        <div className="text-gray-600">Loading task details...</div>
      </div>
    );
  }

  if (taskData.error) {
    return (
      <div className="h-full bg-white flex items-center justify-center">
        <div className="text-red-600">Error loading task details: {taskData.error}</div>
      </div>
    );
  }

  if (!taskData.history || taskData.history.length === 0) {
    return (
      <div className="h-full bg-white flex items-center justify-center">
        <div className="text-gray-600">No history found for task {taskId}</div>
      </div>
    );
  }

  const derivedData = getHistoryDerivedData(taskData.history, taskData.taskInfo);

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Sticky Header Shell - Never scrolls, more compact on mobile */}
      <header className="flex-shrink-0 sticky top-0 z-20 bg-white">
        {/* Task Header Row - Title and Status */}
        <div className="px-3 sm:px-6 py-2 sm:py-3 border-b border-slate-100">
          <TaskHeader taskInfo={taskData.taskInfo} currentStatus={derivedData.currentStatus} />
        </div>

        {/* Consolidated Context Bar - Two rows on mobile, single row on desktop */}
        <div className="px-3 sm:px-6 py-1.5 sm:py-2 bg-slate-50 border-b border-slate-200">
          {/* Mobile: Two-row layout */}
          <div className="flex flex-col gap-2 sm:hidden">
            {/* Row 1: Repo name + Action buttons */}
            <div className="flex items-center justify-between gap-2">
              <ContextStrip
                taskInfo={taskData.taskInfo}
                modelName={derivedData.modelName}
                prInfo={derivedData.prInfo}
                commitInfo={commitInfo}
                duration={totalDuration}
                tokenUsage={tokenUsage}
                usageMetricRecords={taskData.usageMetricRecords}
                mobileRepoOnly={true}
              />
              <ActionBar
                currentStatus={derivedData.currentStatus}
                historyItemWithPaths={derivedData.historyItemWithPaths}
                stoppingExecution={taskData.stoppingExecution}
                stopFailed={taskData.stopFailed}
                deletingTask={taskData.deletingTask}
                onStopExecution={taskData.handleStopExecution}
                onViewPrompt={promptData.fetchPrompt}
                onViewLogs={logFilesData.fetchLogFilesData}
                onDeleteTask={handleDeleteTask}
                onFollowUp={handleOpenFollowup}
              />
            </div>
            {/* Row 2: Metadata (PR ID, task ID, model, etc.) */}
            <ContextStrip
              taskInfo={taskData.taskInfo}
              modelName={derivedData.modelName}
              prInfo={derivedData.prInfo}
              commitInfo={commitInfo}
              duration={totalDuration}
              tokenUsage={tokenUsage}
              usageMetricRecords={taskData.usageMetricRecords}
              mobileMetadataOnly={true}
            />
          </div>

          {/* Desktop: Single row layout */}
          <div className="hidden sm:flex items-center justify-between gap-4">
            <ContextStrip
              taskInfo={taskData.taskInfo}
              modelName={derivedData.modelName}
              prInfo={derivedData.prInfo}
              commitInfo={commitInfo}
              duration={totalDuration}
              tokenUsage={tokenUsage}
              usageMetricRecords={taskData.usageMetricRecords}
            />
            <ActionBar
              currentStatus={derivedData.currentStatus}
              historyItemWithPaths={derivedData.historyItemWithPaths}
              stoppingExecution={taskData.stoppingExecution}
              stopFailed={taskData.stopFailed}
              deletingTask={taskData.deletingTask}
              onStopExecution={taskData.handleStopExecution}
              onViewPrompt={promptData.fetchPrompt}
              onViewLogs={logFilesData.fetchLogFilesData}
              onDeleteTask={handleDeleteTask}
              onFollowUp={handleOpenFollowup}
            />
          </div>
        </div>

        {/* Progress Bar */}
        <ProgressBar todos={taskData.liveDetails.todos} />
      </header>

      {/* Main Content Area - Anchored Shell with 30/70 Split */}
      {/* On mobile: single column with vertical scroll; On desktop: side-by-side with independent scrolls */}
      <div className="flex-1 flex flex-col overflow-y-auto lg:overflow-hidden min-w-0">
        {/* Horizontal Header Row - TIMELINE and IMPLEMENTATION aligned on same baseline */}
        <div className="flex-shrink-0 flex border-b border-slate-200">
          {/* Left Pane Header (30%) */}
          <div className="w-full lg:w-[30%] flex-shrink-0 px-4 flex items-center">
            <div className="py-2 lg:py-2.5 text-xs font-bold uppercase tracking-widest text-slate-500">
              TIMELINE
            </div>
          </div>
          {/* Right Pane Header (70%) - IMPLEMENTATION label aligned with TIMELINE - hidden on mobile since it stacks vertically */}
          <div className="hidden lg:flex flex-1 px-4 items-center gap-3">
            <div className="py-2.5 text-xs font-bold uppercase tracking-widest text-slate-500">
              IMPLEMENTATION
            </div>
            {parsedAnalysis?.implementation_critique_score !== undefined && (
              <GeometricScorePill score={parsedAnalysis.implementation_critique_score} />
            )}
          </div>
        </div>

        {/* Content Area Below the Horizon Line */}
        {/* On mobile: stacked vertically in the scrolling container; On desktop: side-by-side with own scroll */}
        <div className="flex-1 flex flex-col lg:flex-row lg:overflow-hidden min-w-0">
          {/* LEFT PANE (30%) - The Plan */}
          {/* On mobile: no overflow, participates in parent scroll; On desktop: independent scroll */}
          <div className="w-full lg:w-[30%] flex-shrink-0 lg:overflow-y-auto scrollbar-stealth border-b lg:border-b-0 lg:border-r border-gray-200">
            <div className="p-3 lg:p-4 space-y-2">
              {/* Compact Status Timeline */}
              <TaskStatusTable history={taskData.history} compact={true} />

              {/* Execution Rail - unified task sequence with vertical threading */}
              <ExecutionRail
                liveDetails={taskData.liveDetails}
                history={taskData.history}
                onTodoHover={setHighlightedTodoId}
              />

              {/* Live File Changes - dense monospace code chips */}
              {taskId && taskData.history.length > 0 && (
                <LiveFileChips
                  taskId={taskId}
                  isActive={derivedData.isTaskActive}
                />
              )}
            </div>
          </div>

          {/* Vertical Divider Line (visible on lg+) */}
          <div className="hidden lg:block w-px bg-gray-200 flex-shrink-0" />

          {/* RIGHT PANE (70%) - The Execution */}
          {/* On mobile: IMPLEMENTATION header + content inline; On desktop: independent scroll */}
          <div className="flex flex-1 flex-col min-h-0 min-w-0 lg:overflow-hidden">
            {/* Mobile IMPLEMENTATION header - shown only on mobile */}
            <div className="lg:hidden flex-shrink-0 px-4 py-2 border-b border-slate-200 flex items-center gap-3">
              <div className="text-xs font-bold uppercase tracking-widest text-slate-500">
                IMPLEMENTATION
              </div>
              {parsedAnalysis?.implementation_critique_score !== undefined && (
                <GeometricScorePill score={parsedAnalysis.implementation_critique_score} />
              )}
            </div>
            {/* Scrollable Content Area - Implementation Analysis + Thinking Log in same scroll flow */}
            {/* Remains visible when Execution Log is expanded so both logs can share vertical space */}
            <div className="flex-1 flex flex-col min-h-0 min-w-0 lg:overflow-hidden">
              {/* Single scrollable area for Implementation Analysis + Thinking Log */}
              {/* On mobile: no overflow (parent scrolls); On desktop: independent scroll */}
              <div className="flex-1 lg:overflow-y-auto overflow-x-hidden scrollbar-stealth min-h-0 min-w-0">
                {/* Implementation Analysis - now scrolls with Thinking Log */}
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

                {/* Implementation Log - Terminal Style - in same scroll flow */}
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

      {/* VS Code Terminal Footer - Execution Event Log - Fixed at bottom */}
      {/* On mobile, expanded log takes full height; on desktop, max 60vh */}
      <div
        ref={executionLogRef}
        className={`flex-shrink-0 transition-all duration-300 ease-in-out min-w-0 overflow-hidden ${thinkingLog.eventsCollapsed ? '' : 'flex-1 flex flex-col min-h-0 max-h-[100vh] lg:max-h-[60vh]'}`}
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
