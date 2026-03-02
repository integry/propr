import React, { useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { renderMarkdown } from './renderMarkdown';
import TaskStatusTable from './TaskStatusTable';
import ExecutionRail from './ExecutionRail';
import LiveFileChips from './LiveFileChips';
import ThinkingLog from './ThinkingLog';
import ExecutionEventLog from './ExecutionEventLog';
import ResultOverview from './ResultOverview';
import { detectThoughtType, getEventCategory } from './utils';
import RightPaneHeader, { ThoughtType, EventType } from './RightPaneHeader';
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

  // State for right pane filters
  const [activeThoughtFilters, setActiveThoughtFilters] = useState<Set<string>>(new Set());
  const [activeEventFilters, setActiveEventFilters] = useState<Set<string>>(new Set());

  // State for right pane active tab
  const [activeRightPaneTab, setActiveRightPaneTab] = useState<'thoughts' | 'events'>('thoughts');

  // State for detailed analysis expansion (lifted from ResultOverview to persist across Execution Log toggles)
  const [detailedAnalysisExpanded, setDetailedAnalysisExpanded] = useState<boolean | undefined>(undefined);

  // Toggle thought filter
  const toggleThoughtFilter = useCallback((type: ThoughtType) => {
    setActiveThoughtFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  // Toggle event filter
  const toggleEventFilter = useCallback((type: EventType) => {
    setActiveEventFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    setActiveThoughtFilters(new Set());
    setActiveEventFilters(new Set());
  }, []);

  // Calculate thought type counts
  const thoughtTypeCounts = useMemo(() => {
    const counts: Record<ThoughtType, number> = {
      analysis: 0,
      action: 0,
      search: 0,
      summary: 0
    };

    thinkingLog.thinkingLogWithTimestamps.forEach(event => {
      const type = detectThoughtType(event.content || '');
      counts[type]++;
    });

    return counts;
  }, [thinkingLog.thinkingLogWithTimestamps]);

  // Calculate event type counts
  const eventTypeCounts = useMemo(() => {
    const counts: Record<EventType, number> = {
      thought: 0,
      read: 0,
      write: 0,
      bash: 0,
      search: 0,
      tool_use: 0,
      tool_result: 0
    };

    taskData.liveDetails.events.forEach(event => {
      const category = getEventCategory(event);
      counts[category]++;
    });

    return counts;
  }, [taskData.liveDetails.events]);

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

  // Helper to parse analysis data (same logic as DeepDiveAnalysis)
  const parseAnalysisData = useCallback((rawAnalysis: unknown): {
    recommendations?: string[];
    error_analysis?: string;
    implementation_critique?: string;
    efficiency_notes?: string;
  } | null => {
    if (!rawAnalysis) return null;

    // First, parse if it's a string (might be double-encoded JSON)
    let parsed = rawAnalysis;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
        // Handle double-encoded JSON
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed);
        }
      } catch {
        return null;
      }
    }

    // Check if we have a 'report' field that contains the actual data
    if (typeof parsed === 'object' && parsed !== null && 'report' in parsed) {
      const analysisObj = parsed as { report?: string };
      if (analysisObj.report) {
        try {
          let reportText = analysisObj.report;
          // Extract JSON from markdown code blocks if present
          const jsonMatch = reportText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
          if (jsonMatch) {
            reportText = jsonMatch[1].trim();
          }
          return JSON.parse(reportText);
        } catch {
          return null;
        }
      }
    }

    return parsed as {
      recommendations?: string[];
      error_analysis?: string;
      implementation_critique?: string;
      efficiency_notes?: string;
    };
  }, []);

  // Generate initial content for follow-up based on analysis data
  const generateFollowupContent = useCallback(() => {
    const analysis = parseAnalysisData(taskData.analysis);

    if (!analysis) {
      return 'Please address the following based on the previous task execution:\n\n';
    }

    const parts: string[] = [];

    // Check if task failed
    const latestState = taskData.history?.[taskData.history.length - 1]?.state?.toUpperCase();
    const isFailed = latestState === 'FAILED';

    if (isFailed && analysis.error_analysis) {
      parts.push('## Issue to Fix\n');
      parts.push(analysis.error_analysis);
      parts.push('\n');
    }

    if (analysis.recommendations && analysis.recommendations.length > 0) {
      parts.push('## Recommendations to Address\n');
      analysis.recommendations.forEach((rec, idx) => {
        parts.push(`${idx + 1}. ${rec}`);
      });
      parts.push('\n');
    }

    if (analysis.implementation_critique) {
      parts.push('## Implementation Feedback\n');
      parts.push(analysis.implementation_critique);
      parts.push('\n');
    }

    if (parts.length === 0) {
      return 'Please address the following based on the previous task execution:\n\n';
    }

    return parts.join('\n');
  }, [taskData.analysis, taskData.history, parseAnalysisData]);

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
      {/* Sticky Header Shell - Never scrolls */}
      <header className="flex-shrink-0 sticky top-0 z-20 bg-white border-b border-gray-200">
        {/* Task Header with Actions */}
        <div className="px-4 sm:px-6 py-3 flex items-start justify-between gap-4">
          {/* Left: Task Header */}
          <div className="flex-1 min-w-0">
            <TaskHeader taskInfo={taskData.taskInfo} currentStatus={derivedData.currentStatus} />
          </div>

          {/* Right: Actions */}
          <div className="flex-shrink-0">
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

        {/* Context Strip - Dense metadata line with continuous border */}
        <div className="px-4 sm:px-6 border-b border-gray-200">
          <ContextStrip
            taskInfo={taskData.taskInfo}
            modelName={derivedData.modelName}
            prInfo={derivedData.prInfo}
            commitInfo={commitInfo}
            duration={totalDuration}
            tokenUsage={tokenUsage}
          />
        </div>

        {/* Progress Bar */}
        <ProgressBar todos={taskData.liveDetails.todos} />
      </header>

      {/* Main Content Area - Anchored Shell with 30/70 Split */}
      <div className="flex-1 flex overflow-hidden min-w-0">
        {/* LEFT PANE (30%) - The Plan */}
        <div className="w-full lg:w-[30%] flex-shrink-0 overflow-y-auto scrollbar-stealth border-r border-gray-200">
          <div className="p-4 space-y-4">
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
        <div className="hidden lg:flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
          {/* Scrollable Content Area - Implementation Analysis + Thinking Log in same scroll flow */}
          {/* Hidden when Execution Log is expanded */}
          {thinkingLog.eventsCollapsed && (
            <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
              {/* Anchored Header with Tabs and Filters */}
              <div className="flex-shrink-0">
                <RightPaneHeader
                  thoughtCount={thinkingLog.thinkingLogWithTimestamps.length}
                  thoughtTypeCounts={thoughtTypeCounts}
                  activeThoughtFilters={activeThoughtFilters}
                  onToggleThoughtFilter={toggleThoughtFilter}
                  eventCount={taskData.liveDetails.events.length}
                  eventTypeCounts={eventTypeCounts}
                  activeEventFilters={activeEventFilters}
                  onToggleEventFilter={toggleEventFilter}
                  onClearAllFilters={clearAllFilters}
                  activeTab={activeRightPaneTab}
                  onTabChange={setActiveRightPaneTab}
                />
              </div>

              {/* Single scrollable area for Implementation Analysis + Thinking Log */}
              <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-stealth min-h-0 min-w-0">
                {/* Implementation Analysis - now scrolls with Thinking Log */}
                {(taskData.analysis || taskData.analysisLoading) && (
                  <ResultOverview
                    analysis={taskData.analysis}
                    loading={taskData.analysisLoading}
                    renderMarkdown={renderMarkdown}
                    totalThoughts={thinkingLog.thinkingLogWithTimestamps.length}
                    detailedAnalysisExpanded={detailedAnalysisExpanded}
                    onDetailedAnalysisToggle={setDetailedAnalysisExpanded}
                  />
                )}

                {/* Thinking Log - Terminal Style - in same scroll flow */}
                <div className="p-4 min-w-0 overflow-hidden">
                  <ThinkingLog
                    events={thinkingLog.thinkingLogWithTimestamps}
                    todos={taskData.liveDetails.todos}
                    highlightedTodoId={highlightedTodoId}
                    activeFilters={activeThoughtFilters}
                  />
                </div>
              </div>
            </div>
          )}

          {/* VS Code Terminal Footer - Execution Event Log - Fills entire height when expanded */}
          <div className={`transition-all duration-300 ease-in-out min-w-0 overflow-hidden ${thinkingLog.eventsCollapsed ? 'flex-shrink-0' : 'flex-1 flex flex-col min-h-0'}`}>
            <ExecutionEventLog
              events={taskData.liveDetails.events}
              collapsed={thinkingLog.eventsCollapsed}
              onToggleCollapse={thinkingLog.toggleEventsCollapse}
              lastThought={thinkingLog.lastThought}
              isTaskActive={derivedData.isTaskActive}
              taskInfo={taskData.taskInfo}
              activeFilters={activeEventFilters}
            />
          </div>
        </div>
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
        initialContent={generateFollowupContent()}
        taskInfo={taskData.taskInfo}
      />
    </div>
  );
};

export default TaskDetails;
