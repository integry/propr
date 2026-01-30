import { useState, useEffect } from 'react';
import {
  getTaskHistory,
  getTaskLiveDetails,
  getTaskAnalysis,
  stopTaskExecution,
  StopExecutionResponse
} from '../../api/gitfixApi';
import {
  HistoryItem,
  TaskInfo,
  LiveDetails,
  AnalysisData
} from './types';

export const useTaskData = (taskId: string | undefined) => {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [taskInfo, setTaskInfo] = useState<TaskInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [liveDetails, setLiveDetails] = useState<LiveDetails>({ events: [], todos: [], currentTask: null });
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState<boolean>(true);
  const [stoppingExecution, setStoppingExecution] = useState<boolean>(false);

  useEffect(() => {
    const fetchHistory = async () => {
      if (!taskId) return;
      
      try {
        setLoading(true);
        const data = await getTaskHistory(taskId);
        setHistory(data.history || []);
        setTaskInfo(data.taskInfo || null);
        
        const isTaskActive = data.history && data.history.length > 0 && 
          ['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(
            data.history[data.history.length - 1]?.state?.toUpperCase()
          );
        
        if (isTaskActive) {
          const interval = setInterval(async () => {
            try {
              const updatedData = await getTaskHistory(taskId);
              setHistory(updatedData.history || []);
              setTaskInfo(updatedData.taskInfo || null);
              
              const stillActive = updatedData.history && updatedData.history.length > 0 && 
                ['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(
                  updatedData.history[updatedData.history.length - 1]?.state?.toUpperCase()
                );
              
              if (!stillActive) {
                clearInterval(interval);
              }
            } catch (err) {
              console.error('Error polling task history:', err);
            }
          }, 3000);
          
          return () => clearInterval(interval);
        }
      } catch (err) {
        setError((err as Error).message);
        console.error('Error fetching task history:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [taskId]);

  useEffect(() => {
    const fetchAnalysis = async () => {
      if (!taskId) return;
      
      try {
        setAnalysisLoading(true);
        const analysisData = await getTaskAnalysis(taskId);
        setAnalysis(analysisData.analysis);
      } catch (err) {
        console.error('Error fetching analysis:', err);
      } finally {
        setAnalysisLoading(false);
      }
    };

    fetchAnalysis();
  }, [taskId]);

  useEffect(() => {
    if (!taskId || history.length === 0) return;

    const lastHistoryItem = history[history.length - 1];
    const isTaskActive = lastHistoryItem && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(lastHistoryItem.state?.toUpperCase() || '');

    const fetchLiveDetails = async () => {
      try {
        const data = await getTaskLiveDetails(taskId);
        setLiveDetails(data);
      } catch (err) {
        console.error('Error fetching live task details:', err);
      }
    };

    fetchLiveDetails();

    if (isTaskActive) {
      const interval = setInterval(fetchLiveDetails, 3000);
      return () => clearInterval(interval);
    }
  }, [taskId, history]);

  const handleStopExecution = async () => {
    if (!taskId) return;

    const confirmed = window.confirm('Are you sure you want to stop this execution? This action cannot be undone.');
    if (!confirmed) return;

    try {
      setStoppingExecution(true);
      const result: StopExecutionResponse = await stopTaskExecution(taskId);

      // Immediately refresh task history to show the new state
      const refreshHistory = async () => {
        try {
          const data = await getTaskHistory(taskId);
          setHistory(data.history || []);
          setTaskInfo(data.taskInfo || null);
        } catch (err) {
          console.error('Error refreshing task history after stop:', err);
        }
      };

      // Refresh immediately
      await refreshHistory();

      // If container was stopped successfully, clear stopping state immediately
      // Otherwise, poll a couple more times to wait for state to update
      if (result.containerStopped) {
        setStoppingExecution(false);
      } else {
        // Container might still be stopping, poll for updates
        let pollCount = 0;
        const pollInterval = setInterval(async () => {
          pollCount++;
          await refreshHistory();

          // Check if task is now in a terminal state
          const updatedData = await getTaskHistory(taskId);
          const latestState = updatedData.history?.[updatedData.history.length - 1]?.state?.toUpperCase();
          const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(latestState || '');

          if (isTerminal || pollCount >= 5) {
            clearInterval(pollInterval);
            setStoppingExecution(false);
          }
        }, 1500);
      }
    } catch (err) {
      console.error('Error stopping execution:', err);
      alert(`Failed to stop execution: ${(err as Error).message || 'Unknown error'}. Please try again.`);
      setStoppingExecution(false);
    }
  };

  return {
    history,
    taskInfo,
    loading,
    error,
    liveDetails,
    analysis,
    analysisLoading,
    stoppingExecution,
    handleStopExecution
  };
};
