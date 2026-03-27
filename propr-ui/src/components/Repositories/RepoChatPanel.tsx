import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { User, Bot, Send, Loader2, Clock, Trash2, X } from 'lucide-react';
import ModelContextSelector from './ModelContextSelector';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';

/** Maximum progress percentage to show when execution takes longer than estimated */
const MAX_PROGRESS_PERCENT = 95;

/** Threshold for showing humorous messages (60 seconds) */
const LONG_ESTIMATE_THRESHOLD_MS = 60000;

/** Interval for rotating humorous messages (10 seconds) */
const MESSAGE_ROTATION_INTERVAL_MS = 10000;

/** Humorous messages to display when estimate is > 60 seconds and taking longer than expected */
const HUMOROUS_MESSAGES = [
  "It may be slow, but it's worth the wait...",
  "Reticulating splines...",
  "Consulting the oracle...",
  "Teaching AI to be patient...",
  "Brewing some digital coffee...",
  "Counting to infinity (almost there)...",
  "Asking the hamsters to run faster...",
  "Polishing the response...",
  "Good things come to those who wait...",
  "The AI is deep in thought...",
];

/**
 * Response metadata including timing information
 */
export interface ChatResponseMetadata {
  /** Estimated duration for the LLM call in milliseconds */
  estimatedDurationMs?: number;
  /** Actual duration for the LLM call in milliseconds */
  actualDurationMs?: number;
  /** Whether the estimate is based on historical data */
  isHistoricalEstimate?: boolean;
}

/**
 * Response from the send message callback
 */
export interface ChatResponse {
  reply: string;
  metadata?: ChatResponseMetadata;
}

/**
 * Represents a single message in the chat history.
 */
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Metadata for assistant messages (timing info) */
  metadata?: ChatResponseMetadata;
}

/** Format duration for display (e.g., "1m 30s") */
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
};

/**
 * Estimate expected duration based on context level.
 * Higher context = more tokens = longer duration.
 */
const getEstimatedDuration = (contextLevel: number): number => {
  // Base estimate: 15-60 seconds depending on context level
  // Focused (20%): ~15s, Expanded (50%): ~30s, Full Scan (90%): ~60s
  const baseMs = 10000; // 10 seconds minimum
  const scaleFactor = 500; // ms per context percentage point
  return baseMs + (contextLevel * scaleFactor);
};

/**
 * Progress indicator component for chat loading state.
 */
interface ChatProgressProps {
  startedAt: number;
  estimatedDuration: number;
}

const ChatProgress: React.FC<ChatProgressProps> = ({ startedAt, estimatedDuration }) => {
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [messageIndex, setMessageIndex] = useState(0);

  // Determine if this is a long estimate (> 60 seconds)
  const isLongEstimate = estimatedDuration > LONG_ESTIMATE_THRESHOLD_MS;

  useEffect(() => {
    const updateProgress = () => {
      const now = Date.now();
      const elapsedMs = now - startedAt;
      setElapsed(elapsedMs);

      // Calculate progress percentage, capped at MAX_PROGRESS_PERCENT until completion
      const rawProgress = (elapsedMs / estimatedDuration) * 100;
      setProgress(Math.min(rawProgress, MAX_PROGRESS_PERCENT));
    };

    // Update immediately
    updateProgress();

    // Update every 500ms for smooth progress
    const interval = setInterval(updateProgress, 500);

    return () => clearInterval(interval);
  }, [startedAt, estimatedDuration]);

  // Rotate humorous messages every 10 seconds for long estimates
  useEffect(() => {
    if (!isLongEstimate) return;

    const rotateMessage = () => {
      setMessageIndex(prev => (prev + 1) % HUMOROUS_MESSAGES.length);
    };

    const interval = setInterval(rotateMessage, MESSAGE_ROTATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isLongEstimate]);

  const remaining = Math.max(0, estimatedDuration - elapsed);
  // Only show "Taking longer than expected" after exceeding estimate by 10%
  const isOverEstimate = elapsed > estimatedDuration * 1.1;

  // Determine which message to show when over estimate
  const getOverEstimateMessage = () => {
    if (isLongEstimate) {
      return HUMOROUS_MESSAGES[messageIndex];
    }
    return "Taking longer than expected...";
  };

  return (
    <div className="w-full">
      {/* Progress bar */}
      <div className="w-full h-1 bg-slate-200 rounded-sm overflow-hidden mb-1.5">
        <div
          className="h-full transition-all duration-500 ease-out"
          style={{
            width: `${progress}%`,
            backgroundColor: isOverEstimate ? 'rgb(234, 179, 8)' : 'rgb(29, 138, 138)'
          }}
        />
      </div>
      {/* Progress info */}
      <div className="text-[10px] text-slate-500">
        {isOverEstimate ? (
          <span className="text-amber-600">{getOverEstimateMessage()}</span>
        ) : (
          <span>~{formatDuration(remaining)} remaining</span>
        )}
      </div>
    </div>
  );
};

export interface RepoChatPanelProps {
  /** Callback invoked when the user sends a message - returns reply string or ChatResponse object */
  onSendMessage: (message: string, model: string, contextLevel: number) => Promise<string | ChatResponse | void>;
  /** Current messages (controlled component) */
  messages?: Message[];
  /** Callback when messages change */
  onMessagesChange?: (messages: Message[]) => void;
  /** Callback to delete a single message */
  onDeleteMessage?: (messageId: string) => void;
  /** Callback to clear all messages */
  onClearMessages?: () => void;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Whether the panel is disabled */
  disabled?: boolean;
  /** Repository name to display in empty state */
  repositoryName?: string;
  /** Default model to use (agent:model format, e.g., 'claude:claude-haiku-4-5-20251001') */
  defaultModel?: string;
  /** Default context level */
  defaultContextLevel?: number;
}

const RepoChatPanel: React.FC<RepoChatPanelProps> = ({
  onSendMessage,
  messages: externalMessages,
  onMessagesChange,
  onDeleteMessage,
  onClearMessages,
  placeholder = 'Ask a question about this repository...',
  disabled = false,
  repositoryName,
  defaultModel = 'claude:claude-haiku-4-5-20251001',
  defaultContextLevel = 50,
}) => {
  // Support both controlled and uncontrolled modes
  const [internalMessages, setInternalMessages] = useState<Message[]>([]);
  const messages = externalMessages ?? internalMessages;
  const setMessages = useCallback((updater: Message[] | ((prev: Message[]) => Message[])) => {
    if (onMessagesChange) {
      const newMessages = typeof updater === 'function' ? updater(messages) : updater;
      onMessagesChange(newMessages);
    } else {
      setInternalMessages(updater);
    }
  }, [onMessagesChange, messages]);

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
  const [selectedModel, setSelectedModel] = useState(defaultModel);
  const [contextLevel, setContextLevel] = useState(defaultContextLevel);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Estimated duration based on current context level
  const estimatedDuration = useMemo(() => getEstimatedDuration(contextLevel), [contextLevel]);

  // Handle delete message
  const handleDeleteMessage = useCallback((messageId: string) => {
    if (onDeleteMessage) {
      onDeleteMessage(messageId);
    } else {
      setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
    }
  }, [onDeleteMessage, setMessages]);

  // Handle clear all messages
  const handleClearMessages = useCallback(() => {
    if (onClearMessages) {
      onClearMessages();
    } else {
      setMessages([]);
    }
  }, [onClearMessages, setMessages]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // Focus input on mount
  useEffect(() => {
    if (inputRef.current && !disabled) {
      inputRef.current.focus();
    }
  }, [disabled]);

  const generateId = () => `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const handleSend = async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput || isLoading || disabled) return;

    // Add user message
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: trimmedInput,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setLoadingStartedAt(Date.now());

    try {
      const response = await onSendMessage(trimmedInput, selectedModel, contextLevel);

      // Add assistant message if a response is returned
      if (response) {
        // Handle both string and ChatResponse object responses
        const isStringResponse = typeof response === 'string';
        const reply = isStringResponse ? response : response.reply;
        const metadata = isStringResponse ? undefined : response.metadata;

        const assistantMessage: Message = {
          id: generateId(),
          role: 'assistant',
          content: reply,
          timestamp: Date.now(),
          metadata,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      }
    } catch (error) {
      // Add error message as assistant response
      const errorMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: `An error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setLoadingStartedAt(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Model and Context Level Selector with Clear button */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white">
        <ModelContextSelector
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          contextLevel={contextLevel}
          onContextLevelChange={setContextLevel}
          disabled={isLoading || disabled}
          className="flex-1 border-b-0"
        />
        {messages.length > 0 && (
          <button
            onClick={handleClearMessages}
            disabled={isLoading || disabled}
            className="mr-2 p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Clear all messages"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* Messages Area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: '#d1d5db transparent',
        }}
      >
        {messages.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center mb-3">
              <Bot size={24} className="text-gray-400" />
            </div>
            <h3 className="text-sm font-medium text-gray-700 mb-1">
              {repositoryName ? `Chat with ${repositoryName}` : 'Repository Chat'}
            </h3>
            <p className="text-xs text-gray-500 max-w-xs">
              Ask questions about the codebase, request explanations, or explore the repository structure.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className="flex items-start group"
            onMouseEnter={() => setHoveredMessageId(msg.id)}
            onMouseLeave={() => setHoveredMessageId(null)}
          >
            {/* Icon column */}
            <div className="w-10 flex-shrink-0 flex justify-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  msg.role === 'user'
                    ? 'bg-white border border-slate-200'
                    : 'bg-gray-700'
                }`}
              >
                {msg.role === 'user' ? (
                  <User size={16} className="text-slate-600" />
                ) : (
                  <Bot size={16} className="text-white" />
                )}
              </div>
            </div>

            {/* Message content */}
            <div className="flex-1 min-w-0 ml-3">
              <div className="relative">
                <div
                  className={`inline-block px-4 py-2 rounded-lg max-w-full ${
                    msg.role === 'user'
                      ? 'bg-white border border-indigo-100 text-slate-800 shadow-sm'
                      : 'bg-white border border-gray-200 text-gray-800'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                  ) : (
                    <div className="text-sm prose prose-sm max-w-none prose-slate prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5">
                      <MarkdownRenderer text={msg.content} />
                    </div>
                  )}
                </div>
                {/* Delete button - visible on hover */}
                {hoveredMessageId === msg.id && !isLoading && (
                  <button
                    onClick={() => handleDeleteMessage(msg.id)}
                    className="absolute -right-1 -top-1 p-1 rounded-full bg-red-100 text-red-600 hover:bg-red-200 transition-colors shadow-sm"
                    title="Delete message"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400">
                <span>
                  {new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                {/* Show timing metadata for assistant messages */}
                {msg.role === 'assistant' && msg.metadata?.actualDurationMs && (
                  <span className="flex items-center gap-1 text-slate-400">
                    <Clock size={10} />
                    <span>{formatDuration(msg.metadata.actualDurationMs)}</span>
                    {msg.metadata.estimatedDurationMs && (
                      <span className="text-slate-300">
                        (est. {formatDuration(msg.metadata.estimatedDurationMs)})
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}

        {/* Loading state with progress */}
        {isLoading && loadingStartedAt && (
          <div className="flex items-start">
            <div className="w-10 flex-shrink-0 flex justify-center">
              <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: 'rgb(29, 138, 138)' }}>
                <Loader2 size={16} className="text-white animate-spin" />
              </div>
            </div>
            <div className="flex-1 min-w-0 ml-3">
              <div className="bg-gray-100 text-gray-600 px-4 py-2 rounded-lg max-w-xs">
                <p className="text-sm mb-2">Analyzing repository...</p>
                <ChatProgress
                  startedAt={loadingStartedAt}
                  estimatedDuration={estimatedDuration}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="flex-shrink-0 p-4 border-t border-gray-200 bg-white">
        <div className="flex gap-2 items-end bg-gray-50 rounded-lg border border-slate-200 p-2">
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent px-3 py-2 focus:outline-none text-sm placeholder-gray-400"
            placeholder={placeholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || disabled}
          />
          <span className="text-xs text-gray-400 self-center mr-1 flex-shrink-0 hidden sm:inline">
            ↵
          </span>
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim() || disabled}
            className="p-2 rounded-md transition-colors flex items-center justify-center flex-shrink-0 bg-primary-600 text-white hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            aria-label="Send message"
          >
            {isLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Send size={16} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RepoChatPanel;
