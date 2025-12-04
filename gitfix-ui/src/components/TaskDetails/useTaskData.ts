import { useState, useEffect, useRef } from 'react';
import { 
  getTaskHistory, 
  getTaskLiveDetails, 
  getTaskAnalysis, 
  fetchPrompt as apiFetchPrompt, 
  fetchLogFiles as apiFetchLogFiles, 
  fetchLogFile as apiFetchLogFile, 
  stopTaskExecution, 
  generateDeepDiveAnalysis 
} from '../../api/gitfixApi';
import { 
  HistoryItem, 
  TaskInfo, 
  PromptData, 
  LogFilesData, 
  SelectedLogFileData, 
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
  const [deepDiveLoading, setDeepDiveLoading] = useState<boolean>(false);
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
    const isTaskActive = lastHistoryItem && !['COMPLETED', 'FAILED'].includes(lastHistoryItem.state?.toUpperCase() || '');

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
      await stopTaskExecution(taskId);
      
      setTimeout(async () => {
        try {
          const data = await getTaskHistory(taskId);
          setHistory(data.history || []);
        } catch (err) {
          console.error('Error refreshing task history after stop:', err);
        }
        setStoppingExecution(false);
      }, 1000);
    } catch (err) {
      console.error('Error stopping execution:', err);
      alert(`Failed to stop execution: ${(err as Error).message || 'Unknown error'}`);
      setStoppingExecution(false);
    }
  };

  const handleDeepDive = async () => {
    if (!taskId) return;
    setDeepDiveLoading(true);
    try {
      const data = await generateDeepDiveAnalysis(taskId);
      setAnalysis(data.analysis);
    } catch (err) {
      const errMessage = (err as Error).message;
      if (errMessage && errMessage.includes('already been run')) {
        alert('Deep-dive analysis has already been run for this task.');
      } else {
        setAnalysis({ error: errMessage || 'Failed to run deep-dive analysis.' });
      }
    } finally {
      setDeepDiveLoading(false);
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
    deepDiveLoading,
    stoppingExecution,
    handleStopExecution,
    handleDeepDive
  };
};

export const usePromptData = () => {
  const [selectedPrompt, setSelectedPrompt] = useState<PromptData | null>(null);
  const [loadingPrompt, setLoadingPrompt] = useState<boolean>(false);

  const fetchPrompt = async (promptPath: string) => {
    try {
      setLoadingPrompt(true);
      const promptData = await apiFetchPrompt(promptPath);
      
      try {
        const parsed = JSON.parse(promptData);
        setSelectedPrompt(parsed);
      } catch {
        setSelectedPrompt({ prompt: promptData });
      }
    } catch (err) {
      console.error('Error fetching prompt:', err);
      setSelectedPrompt({ error: 'Failed to load prompt content.' });
    } finally {
      setLoadingPrompt(false);
    }
  };

  return { selectedPrompt, setSelectedPrompt, loadingPrompt, fetchPrompt };
};

export const useLogFilesData = () => {
  const [logFiles, setLogFiles] = useState<LogFilesData | null>(null);
  const [selectedLogFile, setSelectedLogFile] = useState<SelectedLogFileData | null>(null);
  const [loadingLogFile, setLoadingLogFile] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchMatches, setSearchMatches] = useState<RegExpMatchArray[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);
  const logContentRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (selectedLogFile && searchQuery) {
      const content = selectedLogFile.isJson
        ? JSON.stringify(selectedLogFile.content, null, 2)
        : selectedLogFile.content;
      const regex = new RegExp(searchQuery, 'gi');
      const matches = [...(content as string).matchAll(regex)];
      setSearchMatches(matches);
      setCurrentMatchIndex(0);
    } else {
      setSearchMatches([]);
    }
  }, [searchQuery, selectedLogFile]);

  useEffect(() => {
    if (searchMatches.length > 0 && logContentRef.current) {
      const highlightId = `match-${currentMatchIndex}`;
      const element = document.getElementById(highlightId);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [currentMatchIndex, searchMatches]);

  const fetchLogFilesData = async (logsPath: string) => {
    try {
      setLoadingLogFile(true);
      setSelectedLogFile(null);
      const logsData = await apiFetchLogFiles(logsPath);
      
      if (logsData.files) {
        const transformedData = {
          sessionId: logsData.sessionId,
          logFiles: Object.entries(logsData.files).map(([type, path]) => ({
            name: (path as string).split('/').pop() || '',
            path: `/api/execution/${logsData.sessionId}/logs/${type}`,
            size: 0,
            type: type
          }))
        };
        setLogFiles(transformedData);
      } else {
        setLogFiles(logsData);
      }
    } catch (err) {
      console.error('Error fetching log files:', err);
      setLogFiles({ error: 'Failed to load log files.' });
    } finally {
      setLoadingLogFile(false);
    }
  };

  const fetchLogFile = async (fileName: string) => {
    if (!logFiles?.logFiles) return;

    try {
      setLoadingLogFile(true);
      const fileInfo = logFiles.logFiles.find(f => f.name === fileName);
      if (!fileInfo) {
        throw new Error('Log file not found');
      }

      const content = await apiFetchLogFile(fileInfo.path);
      const isJson = fileName.endsWith('.json');

      setSelectedLogFile({
        name: fileName,
        content: isJson ? JSON.parse(content) : content,
        isJson: isJson
      });
      setSearchQuery('');
    } catch (err) {
      console.error('Error fetching log file:', err);
      setSelectedLogFile({
        name: fileName,
        content: 'Failed to load log file content.',
        isJson: false
      });
    } finally {
      setLoadingLogFile(false);
    }
  };

  const closeLogFiles = () => {
    setLogFiles(null);
    setSelectedLogFile(null);
  };

  return {
    logFiles,
    selectedLogFile,
    loadingLogFile,
    searchQuery,
    setSearchQuery,
    searchMatches,
    currentMatchIndex,
    setCurrentMatchIndex,
    logContentRef,
    fetchLogFilesData,
    fetchLogFile,
    closeLogFiles
  };
};
