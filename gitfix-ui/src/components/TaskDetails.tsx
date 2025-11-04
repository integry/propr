import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getTaskHistory, getTaskLiveDetails, fetchPrompt as apiFetchPrompt, fetchLogFiles as apiFetchLogFiles, fetchLogFile as apiFetchLogFile } from '../api/gitfixApi';

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

  // New memo for thinking log
  const thinkingLogEvents = React.useMemo(() => {
    return liveDetails.events.filter(e => e.type === 'thought');
  }, [liveDetails.events]);

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

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  const formatPath = (path) => {
    if (!path) return 'N/A';
    // Extract the important part of the path (after /var/folders/)
    const match = path.match(/\/tasks\/(.+)/);
    return match ? match[1] : path;
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

  if (loading) return <div className="text-gray-600">Loading task details...</div>;
  if (error) return <div className="text-red-600">Error loading task details: {error}</div>;
  if (!history || history.length === 0) return <div className="text-gray-600">No history found for task {taskId}</div>;

  const historyItemWithPaths = history.find(item => item.promptPath || item.logsPath);

  // --- Helper for new UI ---
  const currentStatus = history[history.length - 1]?.state?.toUpperCase();
  const modelName = history.find(item => item.metadata?.model)?.metadata?.model || 'Unknown Model';

  const getStatusIcon = () => {
    if (currentStatus === 'COMPLETED') return '✅';
    if (currentStatus === 'FAILED') return '❌';
    if (['PROCESSING', 'CLAUDE_EXECUTION', 'POST_PROCESSING'].includes(currentStatus)) return '⏳';
    return '📋';
  };
  // --- End Helper ---

  return (
    <div>
      {/* Absolute positioned "Back to Tasks" button */}
      <div className="absolute top-8 right-8">
        <button
          className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors border border-gray-300"
          onClick={() => navigate('/tasks')}
        >
          Back to Tasks
        </button>
      </div>

      {/* 1. Header & Subtitle */}
      <div className="flex items-center gap-3 mb-2">
        <span className="text-2xl">{getStatusIcon()}</span>
        <h2 className="text-2xl font-bold text-gray-900 break-all">
          {taskInfo?.title ? taskInfo.title : `Task: ${taskId}`}
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
          <button
            className="px-3 py-1.5 bg-gray-200 text-gray-500 text-sm rounded-md cursor-not-allowed"
            disabled
          >
            Stop Execution (Soon)
          </button>
          <span className="text-gray-400 hidden md:inline">|</span>
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
        {/* Left Column: Task Status Steps */}
        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <h4 className="text-lg font-semibold text-gray-900 mb-4">Task Status</h4>
          <p>Current Step: <strong>{currentStatus || 'LOADING'}</strong></p>
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
          ) : (
            <h4 className="mt-0 text-blue-900 flex items-center gap-2">
              <span className="text-xl">📋</span>
              Task Execution History
            </h4>
          )}
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
      {thinkingLogEvents.length > 0 && (
        <div className="mb-6">
          <h4 className="text-lg font-semibold text-gray-900 mb-4">Thinking Log</h4>
          <div className="space-y-4 p-4 bg-gray-50 rounded-lg border border-gray-200 max-h-96 overflow-y-auto">
            {thinkingLogEvents.map((event, index) => (
              <div key={index} className="flex items-start gap-3">
                <span className="text-lg mt-1">🧠</span>
                <p className="text-gray-700 italic whitespace-pre-wrap">{event.content}</p>
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
            <div className="mt-4 space-y-4 p-4 bg-white border border-gray-200 rounded-lg max-h-[600px] overflow-y-auto">
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
                        {event.input?.file_path && <p className="text-gray-600 mt-1">File: <span className="font-mono">{event.input.file_path}</span></p>}
                        {event.input?.command && <p className="text-gray-600 mt-1">Command: <code className="bg-gray-100 p-1 rounded font-mono text-xs border border-gray-300">{event.input.command}</code></p>}
                      </div>
                    )}
                    {event.type === 'tool_result' && (
                      <div className={`text-sm p-2 rounded ${event.isError ? 'bg-red-50 border border-red-200' : 'bg-gray-50 border border-gray-200'}`}>
                        <p className={`font-semibold ${event.isError ? 'text-red-600' : 'text-green-600'}`}>Tool Result {event.isError ? '(Error)' : '(Success)'}</p>
                        <pre className="whitespace-pre-wrap font-mono text-xs text-gray-600 mt-1 max-h-40 overflow-y-auto">
                          {typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2)}
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

      {/* Original History Log (now at the bottom) */}
      <h4 className="text-lg font-semibold text-gray-900 mb-4">State Change Log</h4>
      <div className="border border-gray-200 rounded-lg bg-white shadow-sm">
        {history.length === 0 ? (
          <p className="text-gray-500 text-center p-8">No history found for this task</p>
        ) : (
          <div className="flex flex-col gap-4 p-6">
            {history.map((item, index) => (
              <div
                key={index}
                className="border border-gray-200 rounded-md p-4 bg-gray-50"
              >
                <div className="flex justify-between items-start mb-3">
                  <h4 className="font-semibold text-gray-900 capitalize text-lg">
                    {item.event ? item.event.replace(/_/g, ' ') : item.state ? item.state.replace(/_/g, ' ') : 'Unknown Event'}
                  </h4>
                  <span className="text-sm text-gray-500">
                    {formatDate(item.timestamp)}
                  </span>
                </div>
                
                {item.reason && (
                  <p className="text-gray-600 italic mb-2">
                    {item.reason}
                  </p>
                )}

                {item.error && (
                  <p className="my-2 text-red-600">
                    Error: {item.error}
                  </p>
                )}

                {item.message && (
                  <p className="text-gray-700 mb-2">
                    {item.message}
                  </p>
                )}
                
                {item.metadata && (item.metadata.sessionId || item.metadata.conversationId || item.metadata.model || item.metadata.duration || item.metadata.conversationTurns || item.metadata.success !== undefined || item.metadata.pullRequest || item.metadata.githubComment) && (
                  <div className="mt-3 space-y-2">
                    <div className="p-3 bg-white rounded-md border border-gray-200 space-y-2">
                      {item.metadata.sessionId && (
                        <div className="text-sm text-gray-700">
                          <strong>Session ID:</strong> <code className="bg-gray-100 px-2 py-1 rounded border border-gray-300">{item.metadata.sessionId}</code>
                        </div>
                      )}
                      {item.metadata.conversationId && (
                        <div className="text-sm text-gray-700">
                          <strong>Conversation ID:</strong> <code className="bg-gray-100 px-2 py-1 rounded border border-gray-300">{item.metadata.conversationId}</code>
                        </div>
                      )}
                      {item.metadata.model && (
                        <div className="text-sm text-gray-700">
                          <strong>Model:</strong> <span className="text-blue-600">{item.metadata.model}</span>
                        </div>
                      )}
                      {item.metadata.duration && (
                        <div className="text-sm text-gray-700">
                          <strong>Duration:</strong> {(item.metadata.duration / 1000).toFixed(2)}s
                        </div>
                      )}
                      {item.metadata.conversationTurns && (
                        <div className="text-sm text-gray-700">
                          <strong>Conversation Turns:</strong> {item.metadata.conversationTurns}
                        </div>
                      )}
                      {item.metadata.success !== undefined && (
                        <div className="text-sm text-gray-700">
                          <strong>Success:</strong> <span className={item.metadata.success ? 'text-green-600' : 'text-red-600'}>{item.metadata.success ? 'Yes' : 'No'}</span>
                        </div>
                      )}
                      {item.metadata.pullRequest && (
                        <div className="text-sm text-gray-700">
                          <strong>Pull Request:</strong> <a 
                            href={item.metadata.pullRequest.url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-700 underline ml-1"
                          >
                            #{item.metadata.pullRequest.number}
                          </a>
                        </div>
                      )}
                      {item.metadata.githubComment && (
                        <div className="text-sm text-gray-700">
                          <strong>GitHub Comment:</strong> <a 
                            href={item.metadata.githubComment.url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-700 underline ml-1"
                          >
                            View Comment
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {item.metadata?.githubComment?.body && (
                  <div className="mt-3 p-3 bg-white rounded-md border border-gray-200">
                    <div className="text-sm text-gray-600 mb-2 font-semibold">Comment Posted:</div>
                    <div className="text-sm text-gray-700 whitespace-pre-wrap">
                      {item.metadata.githubComment.body}
                    </div>
                  </div>
                )}
                
                {item.prUrl && (
                  <div className="mt-3">
                    <a
                      href={item.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-700 underline"
                    >
                      View Pull Request
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

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
                    <div className="bg-gray-50 rounded-md p-4 space-y-2 border border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-600 uppercase mb-3">Prompt Metadata</h4>
                      {selectedPrompt.sessionId && (
                        <div className="text-sm">
                          <span className="text-gray-600">Session ID:</span>
                          <code className="ml-2 bg-white px-2 py-1 rounded text-gray-700 border border-gray-300">{selectedPrompt.sessionId}</code>
                        </div>
                      )}
                      {selectedPrompt.model && (
                        <div className="text-sm">
                          <span className="text-gray-600">Model:</span>
                          <span className="ml-2 text-blue-600">{selectedPrompt.model}</span>
                        </div>
                      )}
                      {selectedPrompt.timestamp && (
                        <div className="text-sm">
                          <span className="text-gray-600">Timestamp:</span>
                          <span className="ml-2 text-gray-700">{new Date(selectedPrompt.timestamp).toLocaleString()}</span>
                        </div>
                      )}
                      {selectedPrompt.isRetry !== undefined && (
                        <div className="text-sm">
                          <span className="text-gray-600">Is Retry:</span>
                          <span className={`ml-2 ${selectedPrompt.isRetry ? 'text-amber-600' : 'text-gray-700'}`}>
                            {selectedPrompt.isRetry ? 'Yes' : 'No'}
                          </span>
                        </div>
                      )}
                      {selectedPrompt.issueRef && (
                        <div className="text-sm">
                          <span className="text-gray-600">Issue Reference:</span>
                          <div className="ml-2 mt-1 bg-white px-2 py-1 rounded text-gray-700 font-mono text-xs border border-gray-300">
                            {selectedPrompt.issueRef.repoOwner}/{selectedPrompt.issueRef.repoName} #{selectedPrompt.issueRef.number}
                          </div>
                        </div>
                      )}
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