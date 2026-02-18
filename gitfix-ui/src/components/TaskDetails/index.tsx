import React, { useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import DeepDiveAnalysis from '../DeepDiveAnalysis';
import { renderMarkdown } from './renderMarkdown';
import TaskStatusTable from './TaskStatusTable';
import TodoList from './TodoList';
import LiveFileChanges from './LiveFileChanges';
import ThinkingLog from './ThinkingLog';
import ExecutionEventLog from './ExecutionEventLog';
import PromptModal from './PromptModal';
import LogFilesModal from './LogFilesModal';
import FollowupModal from './FollowupModal';
import MetadataBar from './MetadataBar';
import TaskHeader from './TaskHeader';
import ProgressBar from './ProgressBar';
import { useTaskData, usePromptData, useLogFilesData } from './hooks';
import { useThinkingLog } from './useThinkingLog';
import { getHistoryDerivedData } from './useHistoryData';
import { getCleanDocumentTitle } from '../TaskList/utils';
import { useToast } from '../ui/useToast';
import { postTaskFollowup } from '../../api/gitfixApi';

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
    return <div className="text-gray-600">Loading task details...</div>;
  }

  if (taskData.error) {
    return <div className="text-red-600">Error loading task details: {taskData.error}</div>;
  }

  if (!taskData.history || taskData.history.length === 0) {
    return <div className="text-gray-600">No history found for task {taskId}</div>;
  }

  const derivedData = getHistoryDerivedData(taskData.history, taskData.taskInfo);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Sticky Header with Metadata */}
      <MetadataBar
        taskInfo={taskData.taskInfo}
        currentStatus={derivedData.currentStatus}
        modelName={derivedData.modelName}
        prInfo={derivedData.prInfo}
        commitInfo={commitInfo}
        historyItemWithPaths={derivedData.historyItemWithPaths}
        stoppingExecution={taskData.stoppingExecution}
        stopFailed={taskData.stopFailed}
        onStopExecution={taskData.handleStopExecution}
        onViewPrompt={promptData.fetchPrompt}
        onViewLogs={logFilesData.fetchLogFilesData}
        duration={totalDuration}
        deletingTask={taskData.deletingTask}
        onDeleteTask={handleDeleteTask}
        tokenUsage={tokenUsage}
        onFollowUp={handleOpenFollowup}
      />

      {/* Progress Bar */}
      <ProgressBar todos={taskData.liveDetails.todos} />

      {/* Main Content */}
      <div className="max-w-[1600px] mx-auto p-4 sm:p-6">
        {/* Task Header */}
        <TaskHeader taskInfo={taskData.taskInfo} currentStatus={derivedData.currentStatus} />

        {/* Split-Pane Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6">
          {/* LEFT COLUMN: The Plan (35% - 4/12 cols) */}
          <div className="lg:col-span-4 space-y-4 sm:space-y-6">
            {/* Compact Status Timeline */}
            <div className="bg-white rounded-lg shadow-sm">
              <TaskStatusTable history={taskData.history} compact={true} />
            </div>

            {/* Todo List */}
            <TodoList
              liveDetails={taskData.liveDetails}
              history={taskData.history}
              onTodoHover={setHighlightedTodoId}
            />

            {/* Live File Changes - in left column under todo list */}
            {taskId && taskData.history.length > 0 && (
              <LiveFileChanges
                taskId={taskId}
                isActive={derivedData.isTaskActive}
              />
            )}
          </div>

          {/* RIGHT COLUMN: The Execution (65% - 8/12 cols) */}
          <div className="lg:col-span-8 space-y-4 sm:space-y-6">
            {/* Execution Analysis - only show when we have data or are loading */}
            {(taskData.analysis || taskData.analysisLoading) && (
              <DeepDiveAnalysis
                analysis={taskData.analysis}
                loading={taskData.analysisLoading}
                renderMarkdown={renderMarkdown}
                title="Execution Analysis"
                colorScheme="gray"
                emptyStateText="Automated analysis is pending..."
              />
            )}

            {/* Thinking Log */}
            <ThinkingLog
              events={thinkingLog.thinkingLogWithTimestamps}
              todos={taskData.liveDetails.todos}
              highlightedTodoId={highlightedTodoId}
            />

            {/* Execution Event Log */}
            <ExecutionEventLog
              events={taskData.liveDetails.events}
              collapsed={thinkingLog.eventsCollapsed}
              onToggleCollapse={thinkingLog.toggleEventsCollapse}
              lastThought={thinkingLog.lastThought}
              isTaskActive={derivedData.isTaskActive}
              taskInfo={taskData.taskInfo}
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
