import React from 'react';
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
import { useTaskData, usePromptData, useLogFilesData } from './hooks';
import { useThinkingLog } from './useThinkingLog';
import { getHistoryDerivedData } from './useHistoryData';

const TaskDetails: React.FC = () => {
  const { taskId } = useParams();
  const taskData = useTaskData(taskId);
  const promptData = usePromptData();
  const logFilesData = useLogFilesData();
  const thinkingLog = useThinkingLog(taskData.liveDetails, taskData.history);

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
    <div>
      <TaskHeader taskInfo={taskData.taskInfo} currentStatus={derivedData.currentStatus} />

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
      />
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <TaskStatusTable history={taskData.history} />
        <RealTimeStats />
      </div>

      <TodoList liveDetails={taskData.liveDetails} history={taskData.history} />

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

      <ThinkingLog events={thinkingLog.thinkingLogWithTimestamps} />

      <ExecutionEventLog
        events={taskData.liveDetails.events}
        collapsed={thinkingLog.eventsCollapsed}
        onToggleCollapse={thinkingLog.toggleEventsCollapse}
        lastThought={thinkingLog.lastThought}
        isTaskActive={derivedData.isTaskActive}
        taskInfo={taskData.taskInfo}
      />

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
