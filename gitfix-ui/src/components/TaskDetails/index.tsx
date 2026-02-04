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
import MetadataBar from './MetadataBar';
import TaskHeader from './TaskHeader';
import ProgressBar from './ProgressBar';
import { useTaskData, usePromptData, useLogFilesData } from './hooks';
import { useThinkingLog } from './useThinkingLog';
import { getHistoryDerivedData } from './useHistoryData';
import { getCleanDocumentTitle } from '../TaskList/utils';
import { useToast } from '../ui/useToast';

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
    </div>
  );
};

export default TaskDetails;
