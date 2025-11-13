import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getTaskHistory, getTaskLiveDetails, fetchPrompt as apiFetchPrompt, fetchLogFiles as apiFetchLogFiles, fetchLogFile as apiFetchLogFile, stopTaskExecution } from '../api/gitfixApi';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

const TaskDetails: React.FC = () => {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [history, setHistory] = useState<any[]>([]);
  const [taskInfo, setTaskInfo] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<any>(null);
  const [loadingPrompt, setLoadingPrompt] = useState<boolean>(false);
  const [logFiles, setLogFiles] = useState<any>(null);
  const [selectedLogFile, setSelectedLogFile] = useState<any>(null);
  const [loadingLogFile, setLoadingLogFile] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchMatches, setSearchMatches] = useState<any[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);
  const logContentRef = useRef<HTMLPreElement | null>(null);
  const [liveDetails, setLiveDetails] = useState<{ events: any[]; todos: any[]; currentTask: any }>({ events: [], todos: [], currentTask: null });
  const [eventsCollapsed, setEventsCollapsed] = useState<boolean>(true);
  const [lastThought, setLastThought] = useState<string | null>(null);
  const [stoppingExecution, setStoppingExecution] = useState<boolean>(false);

  const WORKSPACE_PREFIXES = [
    '/home/node/workspace',
    /^\/tmp\/git-processor\/worktrees\/[^\/]+\/[^\/]+\/[^\/]+/
  ];

  const formatDisplayPath = (fullPath: string) => {
    if (!fullPath || typeof fullPath !== 'string') {
      return fullPath;
    }
    
    for (const prefix of WORKSPACE_PREFIXES) {
      if (typeof prefix === 'string' && fullPath.startsWith(prefix)) {
        return fullPath.substring(prefix.length);
      } else if (prefix instanceof RegExp) {
        const match = fullPath.match(prefix);
        if (match) {
          return fullPath.substring(match[0].length);
        }
      }
    }
    
    return fullPath;
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  const formatPath = (path) => {
    if (!path) return 'N/A';
    const match = path.match(/\/tasks\/(.+)/);
    return match ? match[1] : path;
  };

  const formatModelName = (modelId) => {
    if (!modelId) return 'Unknown Model';
    const modelMap = {
      'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
      'claude-sonnet-3-5-20240620': 'Claude Sonnet 3.5',
      'claude-opus-3-20240229': 'Claude Opus 3',
      'claude-haiku-3-20240307': 'Claude Haiku 3',
    };
    return modelMap[modelId] || modelId;
  };

  const formatRelativeTime = (milliseconds) => {
    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  const renderMarkdown = (text) => {
    if (!text) return text;

    const parts: any[] = [];
    let lastIndex = 0;

    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        const beforeText = text.substring(lastIndex, match.index);
        parts.push({ type: 'text', content: beforeText });
      }

      const language = match[1] || 'javascript';
      let code = match[2];
      // Remove trailing newline from code blocks
      if (code.endsWith('\n')) {
        code = code.slice(0, -1);
      }
      parts.push({ type: 'code', language, content: code });

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      parts.push({ type: 'text', content: text.substring(lastIndex) });
    }

    if (parts.length === 0) {
      parts.push({ type: 'text', content: text });
    }

    const escapeHtml = (str) => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    return (
      <div>
        {parts.map((part, index) => {
          if (part.type === 'code') {
            const languageLabel = part.language.charAt(0).toUpperCase() + part.language.slice(1);
            return (
              <div key={index} className="my-2 relative">
                <div className="absolute top-2 right-2 text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded z-10">
                  {languageLabel}
                </div>
                <SyntaxHighlighter
                  language={part.language}
                  style={vscDarkPlus}
                  customStyle={{
                    borderRadius: '0.375rem',
                    fontSize: '0.875rem',
                    border: '1px solid #d1d5db',
                    margin: 0
                  }}
                >
                  {part.content}
                </SyntaxHighlighter>
              </div>
            );
          } else {
            let formatted = part.content;
            // Reduce excessive line breaks (more than 2 newlines become 1)
            formatted = formatted.replace(/\n{3,}/g, '\n\n');
            formatted = formatted.replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold text-gray-900 mt-4 mb-2">$1</h2>');
            formatted = formatted.replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold text-gray-800 mt-3 mb-1">$1</h3>');
            formatted = formatted.replace(/^#### (.+)$/gm, '<h4 class="text-sm font-semibold text-gray-700 mt-2 mb-1">$1</h4>');
            formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>');
            formatted = formatted.replace(/\*(.+?)\*/g, '<em class="italic">$1</em>');
            // Escape HTML in inline code blocks
            formatted = formatted.replace(/`([^`]+)`/g, (match, code) => {
              return `<code class="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono border border-gray-300">${escapeHtml(code)}</code>`;
            });
            formatted = formatted.replace(/^- (.+)$/gm, '<li class="ml-4">$1</li>');
            formatted = formatted.replace(/(<li.*<\/li>\n?)+/g, '<ul class="list-disc list-inside space-y-1 my-2">$&</ul>');
            // Convert newlines to <br>
            formatted = formatted.replace(/\n/g, '<br>');
            // Remove <br> tags that come right after closing tags (like </li>, </ul>, </h2>, etc.)
            formatted = formatted.replace(/(\<\/(li|ul|ol|h2|h3|h4|h5|strong|em|code)\>)<br>/gi, '$1');
            // Filter out multiple sequential <br> tags (2 or more) and replace with single one
            formatted = formatted.replace(/(<br[^>]*>\s*){2,}/gi, '<br>');
            return <span key={index} dangerouslySetInnerHTML={{ __html: formatted }} />;
          }
        })}
      </div>
    );
  };

  const renderClickablePath = (fullPath: string) => {
    const cleanPath = formatDisplayPath(fullPath);
    
    if (!cleanPath || !cleanPath.includes('/') || cleanPath.startsWith('http')) {
      return <span className="font-mono">{cleanPath}</span>;
    }

    const REPO_BASE_URL = taskInfo?.repoOwner && taskInfo?.repoName
      ? `https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/blob/main`
      : null;

    if (!REPO_BASE_URL) {
      return <span className="font-mono">{cleanPath}</span>;
    }

    return (
      <a
        href={`${REPO_BASE_URL}/${cleanPath}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-blue-600 hover:text-blue-700 underline"
      >
        {cleanPath}
      </a>
    );
  };

  const handleNextMatch = () => {
    if (searchMatches.length > 0) {
      setCurrentMatchIndex((prev) => (prev + 1) % searchMatches.length);
    }
  };

  const handlePrevMatch = () => {
    if (searchMatches.length > 0) {
      setCurrentMatchIndex((prev) => (prev - 1 + searchMatches.length) % searchMatches.length);
    }
  };

  const highlightContent = (content) => {
    if (!searchQuery) return content;

    const parts = content.split(new RegExp(`(${searchQuery})`, 'gi'));
    let matchCount = 0;

    return parts.map((part, index) => {
      if (part.toLowerCase() === searchQuery.toLowerCase()) {
        const isCurrentMatch = matchCount === currentMatchIndex;
        matchCount++;
        return (
          <span
            key={index}
            id={`match-${matchCount - 1}`}
            className={`${
              isCurrentMatch ? 'bg-yellow-500 text-black' : 'bg-yellow-300 text-black'
            } px-1 rounded`}
          >
            {part}
          </span>
        );
      }
      return part;
    });
  };

  const thinkingLogEvents = React.useMemo(() => {
    return liveDetails.events.filter(e => e.type === 'thought');
  }, [liveDetails.events]);

  const executionStartTime = history.find(item => item.state?.toUpperCase() === 'CLAUDE_EXECUTION')?.timestamp;
  const thinkingLogWithTimestamps = React.useMemo(() => {
    if (!executionStartTime) return thinkingLogEvents;
    const startTime = new Date(executionStartTime).getTime();
    return thinkingLogEvents.map(event => ({
      ...event,
      relativeTime: event.timestamp ? formatRelativeTime(new Date(event.timestamp).getTime() - startTime) : null
    }));
  }, [thinkingLogEvents, executionStartTime]);

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
        setError(err.message);
        console.error('Error fetching task history:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [taskId]);

  useEffect(() => {
    if (!taskId || history.length === 0) return;

    const lastHistoryItem = history[history.length - 1];
    const isTaskActive = lastHistoryItem && !['COMPLETED', 'FAILED'].includes(lastHistoryItem.state?.toUpperCase());

    const fetchLiveDetails = async () => {
      try {
        const data = await getTaskLiveDetails(taskId);
        setLiveDetails(data);
      } catch (err) {
        console.error('Error fetching live task details:', err);
      }
    };

    // Always fetch live details at least once (for both active and completed tasks)
    fetchLiveDetails();

    // Only poll for updates if task is active
    if (isTaskActive) {
      const interval = setInterval(fetchLiveDetails, 3000);
      return () => clearInterval(interval);
    }
  }, [taskId, history]);

  useEffect(() => {
    if (liveDetails.events.length > 0) {
      const lastThoughtEvent = [...liveDetails.events].reverse().find(e => e.type === 'thought');
      setLastThought(lastThoughtEvent?.content ?? null);
    } else {
      setLastThought(null);
    }
  }, [liveDetails]);

  useEffect(() => {
    if (selectedLogFile && searchQuery) {
      const content = selectedLogFile.isJson
        ? JSON.stringify(selectedLogFile.content, null, 2)
        : selectedLogFile.content;
      const regex = new RegExp(searchQuery, 'gi');
      const matches = [...content.matchAll(regex)];
      setSearchMatches(matches);
      setCurrentMatchIndex(0);
    } else {
      setSearchMatches([]);
    }
  }, [searchQuery, selectedLogFile]);

  useEffect(() => {
    if (searchMatches.length > 0 && logContentRef.current) {
      const currentMatch = searchMatches[currentMatchIndex];
      if (currentMatch) {
        const highlightId = `match-${currentMatchIndex}`;
        const element = document.getElementById(highlightId);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  }, [currentMatchIndex, searchMatches]);

  const fetchPrompt = async (promptPath) => {
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

  const fetchLogFiles = async (logsPath) => {
    try {
      setLoadingLogFile(true);
      setSelectedLogFile(null);
      console.log('Fetching log files from:', logsPath);
      const logsData = await apiFetchLogFiles(logsPath);
      console.log('Received log files data:', logsData);
      
      if (logsData.files) {
        const transformedData = {
          sessionId: logsData.sessionId,
          logFiles: Object.entries(logsData.files).map(([type, path]) => ({
            name: path.split('/').pop(),
            path: `/api/execution/${logsData.sessionId}/logs/${type}`,
            size: 0,
            type: type
          }))
        };
        console.log('Transformed log files:', transformedData);
        setLogFiles(transformedData);
      } else {
        console.log('No files property in response, using logsData directly');
        setLogFiles(logsData);
      }
    } catch (err) {
      console.error('Error fetching log files:', err);
      setLogFiles({ error: 'Failed to load log files.' });
    } finally {
      setLoadingLogFile(false);
    }
  };

  const fetchLogFile = async (fileName) => {
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

  const getStatusIcon = (status) => {
    if (status === 'COMPLETED') return '✅';
    if (status === 'FAILED') return '❌';
    if (['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(status)) return '⏳';
    return '📋';
  };

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
      alert(`Failed to stop execution: ${err.message || 'Unknown error'}`);
      setStoppingExecution(false);
    }
  };

  if (loading) return <div className="text-gray-600">Loading task details...</div>;
  if (error) return <div className="text-red-600">Error loading task details: {error}</div>;
  if (!history || history.length === 0) return <div className="text-gray-600">No history found for task {taskId}</div>;

  const historyItemWithPaths = history.find(item => item.promptPath || item.logsPath);

  const currentStatus = history[history.length - 1]?.state?.toUpperCase();
  const modelItem = history.find(item => item.metadata?.model);
  const modelName = formatModelName(modelItem?.metadata?.model || taskInfo?.modelName);

  const completedStep = [...history].reverse().find(item =>
      (item.state?.toUpperCase() === 'COMPLETED' || item.state?.toUpperCase() === 'POST_PROCESSING') && (item.metadata?.pr || item.metadata?.pullRequest)
  );
  const prInfo = completedStep?.metadata?.pr || completedStep?.metadata?.pullRequest;

  return (
    <div>
      {/* 1. Header & Subtitle */}
      <div className="flex items-center gap-3 mb-2">
        <span className="text-2xl">{getStatusIcon(currentStatus)}</span>
        <h2 className="text-2xl font-bold text-gray-900 break-all">
          {taskInfo?.title || 'Loading...'}
        </h2>
      </div>
      {taskInfo && (
        <p className="text-gray-600 mb-6 ml-10">
          {taskInfo.subtitle || (taskInfo.type === 'pr-comment'
            ? `Follow-up changes for PR #${taskInfo.number}`
            : `Initial implementation for Issue #${taskInfo.number}`)}
        </p>
      )}

      {/* 2. Metadata Bar */}
      <div className="flex justify-between items-center mb-6 p-4 bg-gray-50 rounded-md border border-gray-200">
        <div className="flex items-center gap-4 flex-wrap">
          {['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(currentStatus) ? (
            <button
              onClick={handleStopExecution}
              disabled={stoppingExecution}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                stoppingExecution
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-red-600 text-white hover:bg-red-700'
              }`}
            >
              {stoppingExecution ? 'Stopping...' : 'Stop Execution'}
            </button>
          ) : null}
          {['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(currentStatus) && (
            <span className="text-gray-400 hidden md:inline">|</span>
          )}
          {taskInfo && (
            <>
              <span className="text-gray-700 font-semibold">Repository:</span>
              <a
                href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 underline"
              >
                {taskInfo.repoOwner}/{taskInfo.repoName}
              </a>
              <span className="text-gray-400">•</span>
              <span className="text-gray-700 font-semibold">
                {taskInfo.type === 'pr-comment' ? 'Pull Request:' : 'Issue:'}
              </span>
              <a
                href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/${taskInfo.type === 'pr-comment' ? 'pull' : 'issues'}/${taskInfo.number}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 underline"
              >
                #{taskInfo.number}
              </a>
            </>
          )}
          <span className="text-gray-400">•</span>
          <span className="text-gray-700 font-semibold">Model:</span>
          <span className="text-blue-600">{modelName}</span>
          {prInfo?.url && (
            <>
              <span className="text-gray-400">•</span>
              <span className="text-gray-700 font-semibold">Pull Request:</span>
              <a
                href={prInfo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 underline"
              >
                #{prInfo.number}
              </a>
            </>
          )}
        </div>
        <div className="flex gap-2">
          {historyItemWithPaths?.promptPath && (
            <button
              onClick={() => fetchPrompt(historyItemWithPaths.promptPath)}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
            >
              View Prompt
            </button>
          )}
          {historyItemWithPaths?.logsPath && (
            <button
              onClick={() => fetchLogFiles(historyItemWithPaths.logsPath)}
              className="px-3 py-1.5 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 transition-colors"
            >
              View Log Files
            </button>
          )}
        </div>
      </div>
      
      {/* 3. Status & Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Left Column: Task Implementation Status Steps */}
        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <h4 className="text-lg font-semibold text-gray-900 mb-4">Task Implementation Status</h4>
          {history.length > 0 && (
            <div className="mt-0">
              <div>
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b-2 border-gray-300">
                      <th className="text-left py-2 pr-4 text-gray-700 font-semibold">#</th>
                      <th className="text-left py-2 pr-4 text-gray-700 font-semibold">State</th>
                      <th className="text-left py-2 pr-4 text-gray-700 font-semibold">Timestamp</th>
                      <th className="text-right py-2 text-gray-700 font-semibold">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item, index) => {
                      const duration = index < history.length - 1
                        ? new Date(history[index + 1].timestamp).getTime() - new Date(item.timestamp).getTime()
                        : null;
                      
                      let displayLabel = item.state?.replace(/_/g, ' ').toLowerCase();
                      const stateUpper = item.state?.toUpperCase();
                      
                      // Map states to more descriptive labels
                      if (stateUpper === 'PENDING') {
                        displayLabel = 'Task Queued';
                      } else if (stateUpper === 'PROCESSING') {
                        displayLabel = 'Analyzing Request';
                      } else if (stateUpper === 'CLAUDE_EXECUTION' || stateUpper === 'CLAUDE_EXECUTION_STARTED') {
                        const claudeCount = history.slice(0, index + 1).filter(h => {
                          const s = h.state?.toUpperCase();
                          return s === 'CLAUDE_EXECUTION' || s === 'CLAUDE_EXECUTION_STARTED';
                        }).length;
                        
                        // Check reason to determine if this is start or completion
                        if (item.reason?.toLowerCase().includes('completed')) {
                          displayLabel = 'Implementation Completed';
                        } else if (item.reason?.toLowerCase().includes('started')) {
                          if (claudeCount === 1) {
                            displayLabel = 'Implementing Changes';
                          } else {
                            displayLabel = `Retry Implementation ${claudeCount}`;
                          }
                        } else if (item.metadata?.description) {
                          displayLabel = item.metadata.description;
                        } else if (claudeCount === 1) {
                          displayLabel = 'Implementing Changes';
                        } else {
                          displayLabel = `Retry Implementation ${claudeCount}`;
                        }
                      } else if (stateUpper === 'CLAUDE_EXECUTION_COMPLETED') {
                        displayLabel = 'Implementation Completed';
                      } else if (stateUpper === 'POST_PROCESSING') {
                        displayLabel = 'Creating Pull Request';
                      } else if (stateUpper === 'COMPLETED') {
                        displayLabel = 'Task Completed';
                      } else if (stateUpper === 'FAILED') {
                        displayLabel = 'Task Failed';
                      }

                      const itemPrInfo = item.metadata?.pr || item.metadata?.pullRequest;
                      if ((stateUpper === 'COMPLETED' || stateUpper === 'POST_PROCESSING') && itemPrInfo?.url) {
                        displayLabel = (
                          <>{displayLabel}
                            <a
                              href={itemPrInfo.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:text-blue-700 underline ml-2"
                            >
                              (View PR #{itemPrInfo.number})
                            </a>
                          </>
                        );
                      }
                      
                      const isLastItem = index === history.length - 1;
                      const isRunning = isLastItem && duration === null && !['COMPLETED', 'FAILED'].includes(item.state?.toUpperCase());
                      return (
                        <tr key={index} className="border-b border-gray-200">
                          <td className="py-2 pr-4 text-gray-500">{index + 1}</td>
                          <td className={`py-2 pr-4 text-gray-800 ${isLastItem ? 'font-bold' : 'font-medium'}`}>{displayLabel}</td>
                          <td className="py-2 pr-4 text-gray-600 text-xs">{formatDate(item.timestamp)}</td>
                          <td className="py-2 text-gray-600 text-xs text-right">
                            {isRunning ? (
                              <span className="inline-flex items-center gap-1">
                                <svg className="animate-spin h-3 w-3 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                              </span>
                            ) : duration !== null ? formatRelativeTime(duration) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        
        {/* Right Column: Real-time Stats */}
        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <h4 className="text-lg font-semibold text-gray-900 mb-4">Real-time Stats</h4>
          <p className="text-gray-500">Files Added: N/A (Placeholder)</p>
          <p className="text-gray-500">Lines Changed: N/A (Placeholder)</p>
        </div>
      </div>

      {/* 4. To-do List */}
      {liveDetails.todos.length > 0 && history.length > 0 && (
        <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
          {!['COMPLETED', 'FAILED'].includes(history[history.length - 1]?.state?.toUpperCase()) ? (
            <>
              <h4 className="mt-0 text-blue-900 flex items-center gap-2">
                <span className="text-xl">⚡</span>
                Live Task Progress
              </h4>
              {liveDetails.currentTask && (
                <p className="mb-4 p-3 bg-blue-100 rounded-md border-l-4 border-blue-500">
                  <strong className="text-blue-900">Current Task:</strong> {liveDetails.currentTask}
                </p>
              )}
            </>
          ) : null}
          <h5 className="mt-4 mb-2 text-blue-900">To-do List:</h5>
          <ul className="list-none pl-0 m-0">
            {liveDetails.todos.map(todo => (
              <li 
                key={todo.id} 
                className={`flex items-center mb-2 p-2 rounded transition-colors ${
                  todo.status === 'in_progress' ? 'bg-blue-100' : ''
                }`}
              >
                <span className="mr-2 text-lg">
                  {todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '⏳' : '📋'}
                </span>
                <span className={`${
                  todo.status === 'completed' ? 'text-gray-500' : 'text-gray-700'
                } ${
                  todo.status === 'in_progress' ? 'font-bold text-blue-800' : 'font-normal'
                }`}>
                  {todo.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 5. Thinking Log */}
      {thinkingLogWithTimestamps.length > 0 && (
        <div className="mb-6">
          <h4 className="text-lg font-semibold text-gray-900 mb-4">Thinking Log</h4>
          <div className="space-y-4 p-4 bg-gray-50 rounded-lg border border-gray-200 overflow-y-auto">
            {thinkingLogWithTimestamps.map((event, index) => (
              <div key={index} className="flex items-start gap-3">
                <span className="text-lg mt-0">🧠</span>
                <div className="flex-1">
                  <p className="text-gray-700 whitespace-pre-wrap">{renderMarkdown(event.content)}</p>
                  {event.relativeTime && (
                    <p className="text-xs text-gray-500 mt-1">{event.relativeTime}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 6. Full Execution Log (Unaltered, shows all events) */}
      {liveDetails.events.length > 0 && history.length > 0 && (
        <div className="mb-6">
          <div
            className="flex items-center justify-between cursor-pointer p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors border border-gray-200"
            onClick={() => setEventsCollapsed(!eventsCollapsed)}
          >
            <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-3">
              <span>{eventsCollapsed ? '▶' : '▼'}</span>
              <span>
                {!['COMPLETED', 'FAILED'].includes(history[history.length - 1]?.state?.toUpperCase())
                  ? 'Full Execution Event Log'
                  : 'Execution Event Log'}
              </span>
              <span className="text-sm font-normal text-gray-500">({liveDetails.events.length} events)</span>
            </h4>
            {eventsCollapsed && lastThought && (
              <div className="text-sm text-gray-600 italic">
                Thinking: {lastThought.substring(0, 100)}{lastThought.length > 100 ? '...' : ''}
              </div>
            )}
          </div>
          {!eventsCollapsed && (
            <div className="mt-4 space-y-4 p-4 bg-white border border-gray-200 rounded-lg overflow-y-auto">
              {liveDetails.events.map((event, index) => (
                <div key={index} className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-lg">
                    {event.type === 'thought' && '🧠'}
                    {event.type === 'tool_use' && '🛠️'}
                    {event.type === 'tool_result' && (event.isError ? '❌' : '✅')}
                  </div>
                  <div className="flex-1 pt-1">
                    {event.type === 'thought' && (
                      <div className="text-gray-700 italic whitespace-pre-wrap">{event.content}</div>
                    )}
                    {event.type === 'tool_use' && (
                      <div className="text-sm">
                        <p className="font-semibold text-gray-800">Tool: <span className="font-mono bg-gray-100 px-2 py-1 rounded border border-gray-300">{event.toolName}</span></p>
                        {event.input?.file_path && (
                          <p className="text-gray-600 mt-1">
                            File: {renderClickablePath(event.input.file_path)}
                          </p>
                        )}
                        {event.input?.command && <p className="text-gray-600 mt-1">Command: <code className="bg-gray-100 p-1 rounded font-mono text-xs border border-gray-300">{event.input.command}</code></p>}
                      </div>
                    )}
                    {event.type === 'tool_result' && (
                      <div className={`text-sm p-2 rounded ${event.isError ? 'bg-red-50 border border-red-200' : 'bg-gray-50 border border-gray-200'}`}>
                        <p className={`font-semibold ${event.isError ? 'text-red-600' : 'text-green-600'}`}>Tool Result {event.isError ? '(Error)' : '(Success)'}</p>
                        <pre className="whitespace-pre-wrap font-mono text-xs text-gray-600 mt-1 max-h-40 overflow-y-auto">
                          {(() => {
                            let resultText = typeof event.result === 'string'
                              ? event.result
                              : JSON.stringify(event.result, null, 2);
                            
                            for (const prefix of WORKSPACE_PREFIXES) {
                              if (typeof prefix === 'string') {
                                resultText = resultText.split(prefix).join('');
                              } else if (prefix instanceof RegExp) {
                                resultText = resultText.replace(prefix, '');
                              }
                            }
                            
                            return resultText;
                          })()}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}


      {selectedPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[80vh] flex flex-col border border-gray-300 shadow-lg">
            <div className="flex justify-between items-center p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">LLM Prompt</h3>
              <button
                className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
                onClick={() => setSelectedPrompt(null)}
              >
                &times;
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {loadingPrompt ? (
                <div className="text-gray-600">Loading prompt...</div>
              ) : selectedPrompt.error ? (
                <div className="text-red-600">{selectedPrompt.error}</div>
              ) : (
                <div className="space-y-4">
                  {(selectedPrompt.sessionId || selectedPrompt.model || selectedPrompt.timestamp || selectedPrompt.issueRef) && (
                    <div className="bg-gray-50 rounded-md p-4 border border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-600 uppercase mb-3">Prompt Metadata</h4>
                      <table className="w-full text-sm border-collapse">
                        <tbody>
                          {selectedPrompt.sessionId && (
                            <tr className="border-b border-gray-200">
                              <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Session ID:</td>
                              <td className="py-2 text-gray-700">
                                <code className="bg-white px-2 py-1 rounded border border-gray-300 text-xs">{selectedPrompt.sessionId}</code>
                              </td>
                            </tr>
                          )}
                          {selectedPrompt.model && (
                            <tr className="border-b border-gray-200">
                              <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Model:</td>
                              <td className="py-2 text-gray-700">
                                <div className="text-blue-600 font-medium">{formatModelName(selectedPrompt.model)}</div>
                                <div className="text-xs text-gray-500 mt-1">{selectedPrompt.model}</div>
                              </td>
                            </tr>
                          )}
                          {selectedPrompt.timestamp && (
                            <tr className="border-b border-gray-200">
                              <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Timestamp:</td>
                              <td className="py-2 text-gray-700">{new Date(selectedPrompt.timestamp).toLocaleString()}</td>
                            </tr>
                          )}
                          {selectedPrompt.isRetry !== undefined && (
                            <tr className="border-b border-gray-200">
                              <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Is Retry:</td>
                              <td className={`py-2 ${selectedPrompt.isRetry ? 'text-amber-600 font-medium' : 'text-gray-700'}`}>
                                {selectedPrompt.isRetry ? 'Yes' : 'No'}
                              </td>
                            </tr>
                          )}
                          {selectedPrompt.issueRef && (
                            <tr>
                              <td className="py-2 pr-4 text-gray-600 font-medium align-top w-1/3">Issue Reference:</td>
                              <td className="py-2 text-gray-700">
                                <code className="bg-white px-2 py-1 rounded border border-gray-300 text-xs">
                                  {selectedPrompt.issueRef.repoOwner}/{selectedPrompt.issueRef.repoName} #{selectedPrompt.issueRef.number}
                                </code>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                  
                  {selectedPrompt.prompt && (
                    <div>
                      <h4 className="text-sm font-semibold text-gray-600 uppercase mb-2">Prompt Content</h4>
                      {selectedPrompt.prompt.length > 5000 && (
                        <div className="mb-2 text-amber-600 text-sm">
                          Large prompt: {selectedPrompt.prompt.length} characters
                        </div>
                      )}
                      <pre className="whitespace-pre-wrap font-mono text-sm text-gray-700 bg-gray-50 p-4 rounded-md border border-gray-200">
                        {selectedPrompt.prompt}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {logFiles && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-5xl w-full max-h-[80vh] flex flex-col border border-gray-300 shadow-lg">
            <div className="flex justify-between items-center p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Log Files</h3>
              <button
                className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
                onClick={() => {
                  setLogFiles(null);
                  setSelectedLogFile(null);
                }}
              >
                &times;
              </button>
            </div>
            <div className="flex flex-1 overflow-hidden">
              {logFiles.error ? (
                <div className="p-4 text-red-600">{logFiles.error}</div>
              ) : logFiles.logFiles && logFiles.logFiles.length > 0 ? (
                <>
                  <div className="w-1/3 border-r border-gray-200 p-4 overflow-y-auto bg-gray-50">
                    <p className="mb-4 text-gray-600">
                      Select a log file to view:
                    </p>
                    <div className="flex flex-col gap-2">
                      {logFiles.logFiles.map((file) => (
                        <button
                          key={file.name}
                          onClick={() => fetchLogFile(file.name)}
                          className={`text-left p-3 rounded-md transition-colors border ${
                            selectedLogFile?.name === file.name
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-gray-700 hover:bg-gray-100 border-gray-300'
                          }`}
                        >
                          <div className="font-medium mb-1">
                            {file.name}
                          </div>
                          <div className={`text-xs ${
                            selectedLogFile?.name === file.name ? 'text-blue-100' : 'text-gray-500'
                          }`}>
                            {Math.round(file.size / 1024)} KB
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex-1 p-4 overflow-hidden flex flex-col">
                    {selectedLogFile ? (
                      <>
                        <div className="flex justify-between items-center mb-4">
                          <h3 className="text-lg font-semibold text-gray-900">
                            {selectedLogFile.name}
                          </h3>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="Search..."
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              className="px-3 py-1 bg-white text-gray-900 rounded-md text-sm border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                            />
                            {searchMatches.length > 0 && (
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={handlePrevMatch}
                                  className="px-2 py-1 bg-gray-100 text-gray-700 rounded-md text-sm hover:bg-gray-200 border border-gray-300"
                                >
                                  ← Prev
                                </button>
                                <span className="text-sm text-gray-600">
                                  {currentMatchIndex + 1} / {searchMatches.length}
                                </span>
                                <button
                                  onClick={handleNextMatch}
                                  className="px-2 py-1 bg-gray-100 text-gray-700 rounded-md text-sm hover:bg-gray-200 border border-gray-300"
                                >
                                  Next →
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        {loadingLogFile ? (
                          <div className="text-gray-600">Loading log file...</div>
                        ) : (
                          <pre
                            ref={logContentRef}
                            className="whitespace-pre-wrap font-mono text-xs text-gray-700 bg-gray-50 p-4 rounded-md overflow-y-auto flex-1 border border-gray-200"
                          >
                            {selectedLogFile.isJson
                              ? highlightContent(JSON.stringify(selectedLogFile.content, null, 2))
                              : highlightContent(selectedLogFile.content)}
                          </pre>
                        )}
                      </>
                    ) : (
                      <p className="text-gray-600 text-center">
                        Select a log file to view its contents
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <p className="p-4 text-gray-600 text-center">
                  No log files found
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskDetails;