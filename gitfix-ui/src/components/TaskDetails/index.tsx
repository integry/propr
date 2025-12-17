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

  const totalTodos = taskData.liveDetails.todos.length;
  const completedTodos = taskData.liveDetails.todos.filter(t => t.status === 'completed').length;
  const progressPercent = totalTodos > 0 ? (completedTodos / totalTodos) * 100 : 0;

  return (
    <div className="min-h-screen bg-gray-50">
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
        startTime={taskData.history?.[0]?.timestamp}
        endTime={derivedData.isTaskActive ? undefined : taskData.history?.[taskData.history.length - 1]?.timestamp}
      />
      
      <div className="w-full h-1 bg-gray-200">
        <div 
            className="h-full bg-green-500 transition-all duration-500 ease-in-out" 
            style={{ width: `${progressPercent}%` }} 
        />
      </div>

      <div className="max-w-[1600px] mx-auto p-6">
        <TaskHeader taskInfo={taskData.taskInfo} currentStatus={derivedData.currentStatus} />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6">
            
            {/* Left Column (35%) - The Plan */}
            <div className="lg:col-span-4 space-y-6">
                <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                    <TaskStatusTable history={taskData.history} />
                </div>
                
                <TodoList liveDetails={taskData.liveDetails} history={taskData.history} />
                
                <RealTimeStats />
            </div>

            {/* Right Column (65%) - The Execution */}
            <div className="lg:col-span-8 space-y-6">
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
            </div>
        </div>
      </div>

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
