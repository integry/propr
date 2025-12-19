import React, { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import DeepDiveAnalysis from '../DeepDiveAnalysis';
import { renderMarkdown } from './renderMarkdown';
import TaskStatusTable from './TaskStatusTable';
import TodoList from './TodoList';
import ThinkingLog from './ThinkingLog';
import ExecutionEventLog from './ExecutionEventLog';
import PromptModal from './PromptModal';
import LogFilesModal from './LogFilesModal';
import MetadataBar from './MetadataBar';
import TaskHeader from './TaskHeader';
import RealTimeStats from './RealTimeStats';
import ProgressBar from './ProgressBar';
import { useTaskData, usePromptData, useLogFilesData } from './hooks';
import { useThinkingLog } from './useThinkingLog';
import { getHistoryDerivedData } from './useHistoryData';

const TaskDetails: React.FC = () => {
  const { taskId } = useParams();
  const taskData = useTaskData(taskId);
  const promptData = usePromptData();
  const logFilesData = useLogFilesData();
  const thinkingLog = useThinkingLog(taskData.liveDetails, taskData.history);

  // Calculate total duration from history
  const totalDuration = useMemo(() => {
    if (!taskData.history || taskData.history.length === 0) return null;
    const firstTimestamp = taskData.history[0]?.timestamp;
    const lastTimestamp = taskData.history[taskData.history.length - 1]?.timestamp;
    if (!firstTimestamp || !lastTimestamp) return null;
    return new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime();
  }, [taskData.history]);

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
        historyItemWithPaths={derivedData.historyItemWithPaths}
        stoppingExecution={taskData.stoppingExecution}
        onStopExecution={taskData.handleStopExecution}
        onViewPrompt={promptData.fetchPrompt}
        onViewLogs={logFilesData.fetchLogFilesData}
        duration={totalDuration}
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
            <TodoList liveDetails={taskData.liveDetails} history={taskData.history} />

            {/* Real-time Stats */}
            <RealTimeStats />
          </div>

          {/* RIGHT COLUMN: The Execution (65% - 8/12 cols) */}
          <div className="lg:col-span-8 space-y-4 sm:space-y-6">
            {/* Deep Dive Analysis */}
            <DeepDiveAnalysis
              analysis={taskData.analysis}
              loading={taskData.analysisLoading || taskData.deepDiveLoading}
              renderMarkdown={renderMarkdown}
              title="Execution Analysis"
              colorScheme="gray"
              showButton={true}
              buttonText="Run Deep-Dive Analysis"
              onRunAnalysis={taskData.handleDeepDive}
              emptyStateText="Automated analysis is pending..."
            />

            {/* Thinking Log */}
            <ThinkingLog
              events={thinkingLog.thinkingLogWithTimestamps}
              todos={taskData.liveDetails.todos}
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
