import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Bot, User, Loader2, Square } from 'lucide-react';
import { ChatMessage } from '../../api/gitfixApi';
import type { RefinementProgress } from '../../hooks/usePlanRefinement';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: Date;
}

interface RefinementChatProps {
  onSendMessage: (message: string, signal?: AbortSignal) => Promise<{ success: boolean; message: string; action?: 'modified' | 'answered' | 'both'; cancelled?: boolean }>;
  initialMessages?: ChatMessage[];
  onMessagesChange?: (messages: ChatMessage[]) => void;
  refinementProgress?: RefinementProgress;
  onStop?: () => Promise<void>;
}

/** Maximum progress percentage to show when execution takes longer than estimated */
const MAX_PROGRESS_PERCENT = 98;

/** Format duration for display (e.g., "1m 30s") */
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms / 100) / 10}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
};

interface RefinementProgressBarProps {
  startedAt: string;
  estimatedDuration: number;
}

const RefinementProgressBar: React.FC<RefinementProgressBarProps> = ({ startedAt, estimatedDuration }) => {
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const startTime = useMemo(() => new Date(startedAt).getTime(), [startedAt]);

  useEffect(() => {
    const updateProgress = () => {
      const now = Date.now();
      const elapsedMs = now - startTime;
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
  }, [startTime, estimatedDuration]);

  const remaining = Math.max(0, estimatedDuration - elapsed);
  const isOverEstimate = elapsed > estimatedDuration;

  return (
    <div className="mt-2 mb-1">
      {/* Progress bar */}
      <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full transition-all duration-500 ease-out rounded-full"
          style={{
            width: `${progress}%`,
            backgroundColor: isOverEstimate ? 'rgb(234, 179, 8)' : 'rgb(29, 138, 138)'
          }}
        />
      </div>
      {/* Progress info */}
      <div className="flex justify-between mt-1 text-xs text-gray-400">
        <span>
          {isOverEstimate ? (
            <span className="text-yellow-600">Taking longer than expected...</span>
          ) : (
            `~${formatDuration(remaining)} remaining`
          )}
        </span>
        <span>{Math.round(progress)}%</span>
      </div>
    </div>
  );
};

export const RefinementChat: React.FC<RefinementChatProps> = ({ onSendMessage, initialMessages, onMessagesChange, refinementProgress, onStop }) => {
  const [messages, setMessages] = useState<Message[]>(() => {
    if (initialMessages && initialMessages.length > 0) {
      // Map initial messages directly to internal format - seeded messages from backend should be displayed
      return initialMessages.map(m => ({
        ...m,
        timestamp: new Date(m.timestamp)
      }));
    }
    return [];
  });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Auto-resize textarea based on content
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto';
      // Set to scrollHeight, capped by max-height via CSS
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Adjust textarea height when input changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  // Convert messages to ChatMessage format for persistence (excluding 'thinking' messages)
  const toChatMessages = useCallback((msgs: Message[]): ChatMessage[] => {
    return msgs
      .filter(m => m.role !== 'thinking')
      .map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: m.timestamp.toISOString()
      }));
  }, []);

  // Handle keyboard shortcuts: Enter to submit, Shift+Enter for new line
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleStop = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Call the backend abort endpoint to stop server-side processing
    if (onStop) {
      try {
        await onStop();
      } catch (err) {
        console.error('Failed to abort refinement:', err);
      }
    }
  }, [onStop]);

  /**
   * Build an enriched message for the AI that includes:
   * 1. Recent conversation history for context
   * 2. The user's current instruction
   * 3. Safety instructions to preserve unmodified task data
   */
  const buildEnrichedMessage = useCallback((userInstruction: string, conversationHistory: Message[]): string => {
    const parts: string[] = [];

    // Get the last 10 messages (excluding thinking messages) for context
    const recentMessages = conversationHistory
      .filter(m => m.role !== 'thinking')
      .slice(-10);

    if (recentMessages.length > 0) {
      parts.push('## Recent Conversation Context');
      parts.push('The following is the recent conversation history for context:');
      parts.push('');
      for (const msg of recentMessages) {
        const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
        parts.push(`**${roleLabel}:** ${msg.content}`);
      }
      parts.push('');
      parts.push('---');
      parts.push('');
    }

    // Add the current user instruction
    parts.push('## Current Instruction');
    parts.push(userInstruction);
    parts.push('');

    // Add safety instructions to preserve unmodified task data
    parts.push('---');
    parts.push('');
    parts.push('## IMPORTANT: Data Preservation Rules');
    parts.push('When updating the plan, you MUST follow these rules:');
    parts.push('1. **Preserve `id` fields**: Every task has a unique `id` field. Do NOT change or remove `id` values for tasks that are not being modified.');
    parts.push('2. **Preserve `implementation` code**: If a task has an `implementation` field with code, do NOT remove or truncate it unless the user specifically asks to modify that task\'s implementation.');
    parts.push('3. **Only modify what is requested**: Only change the specific tasks or fields that the user has asked you to modify. Leave all other tasks and their data intact.');

    return parts.join('\n');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: new Date()
    };

    const thinkingMessage: Message = {
      id: 'thinking',
      role: 'thinking',
      content: 'AI is thinking...',
      timestamp: new Date()
    };

    const messagesWithUser = [...messages, userMessage];
    setMessages([...messagesWithUser, thinkingMessage]);
    setInput('');
    setIsLoading(true);

    // Create a new AbortController for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Save user message immediately
    onMessagesChange?.(toChatMessages(messagesWithUser));

    // Build enriched message with context and safety instructions
    const enrichedMessage = buildEnrichedMessage(userMessage.content, messages);
    const result = await onSendMessage(enrichedMessage, abortController.signal);

    // Clear the abort controller reference
    abortControllerRef.current = null;

    const assistantMessage: Message = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: result.cancelled
        ? 'Refinement cancelled by user.'
        : (result.success ? result.message : `Error: ${result.message}`),
      timestamp: new Date()
    };

    const finalMessages = [...messagesWithUser, assistantMessage];
    setMessages(finalMessages);
    setIsLoading(false);

    // Save with assistant response
    onMessagesChange?.(toChatMessages(finalMessages));
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Header */}
      <div className="px-4 py-3">
        <div className="flex items-center">
          {/* Fixed 40px icon column to match message gutter alignment */}
          <div className="w-10 flex-shrink-0 flex justify-center">
            <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
              <Bot size={16} className="text-white" />
            </div>
          </div>
          <h3 className="font-semibold text-gray-900 ml-3">Assistant</h3>
        </div>
        {messages.length === 0 && (
          <p className="text-xs text-gray-500 mt-0.5 ml-[52px]">Refine your plan through conversation</p>
        )}
      </div>

      {/* Messages area - no border, fills available space */}
      <div
        className="refinement-chat-messages flex-1 overflow-y-auto px-4 pb-4 space-y-4 [scrollbar-gutter:stable]"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: '#d1d5db transparent'
        }}
      >
        <style>{`
          .refinement-chat-messages::-webkit-scrollbar {
            width: 6px;
          }
          .refinement-chat-messages::-webkit-scrollbar-track {
            background: transparent;
          }
          .refinement-chat-messages::-webkit-scrollbar-thumb {
            background-color: #d1d5db;
            border-radius: 3px;
          }
        `}</style>
        {/* Onboarding Card - shown only when chat is empty */}
        {messages.length === 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm">
            <p className="text-sm text-gray-700 whitespace-pre-wrap">
              I can help you refine this plan. You can:{'\n\n'}
              <strong>Ask questions:</strong>{'\n'}
              - "Why is task #2 structured this way?"{'\n'}
              - "What would happen if we combined these tasks?"{'\n\n'}
              <strong>Give instructions:</strong>{'\n'}
              - "Make the testing task more detailed"{'\n'}
              - "Split the backend task into two"{'\n'}
              - "Add error handling to all tasks"
            </p>
          </div>
        )}
        {messages.map((message, index) => (
          <div
            key={message.id}
            className={`flex items-start pb-6 ${index < messages.length - 1 ? 'border-b border-slate-100' : ''}`}
          >
            {/* Fixed 40px icon column for gutter alignment */}
            <div className="w-10 flex-shrink-0 flex justify-center">
              <div
                className={`
                  w-8 h-8 rounded-full flex items-center justify-center
                  ${message.role === 'thinking' ? 'bg-gray-300' : message.role === 'assistant' ? 'bg-gray-700' : 'bg-white border border-slate-200'}
                `}
              >
                {message.role === 'user' ? (
                  <User size={16} className="text-slate-600" />
                ) : message.role === 'thinking' ? (
                  <Loader2 size={16} className="text-gray-600 animate-spin" />
                ) : (
                  <Bot size={16} className="text-white" />
                )}
              </div>
            </div>
            {/* Message text column - never wraps under icon */}
            <div className="flex-1 min-w-0 ml-3">
              <div
                className={`
                  rounded-lg
                  ${message.role === 'user'
                    ? 'bg-white border border-indigo-100 text-slate-800 shadow-sm px-4 py-2 inline-block'
                    : message.role === 'thinking'
                      ? 'bg-slate-200 text-gray-600 italic p-3 w-full max-w-xs'
                      : 'bg-transparent text-gray-800 inline-block'
                  }
                `}
              >
                <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                {/* Show progress bar for thinking messages when progress data is available */}
                {message.role === 'thinking' && refinementProgress?.startedAt && refinementProgress?.estimatedDuration && (
                  <RefinementProgressBar
                    startedAt={refinementProgress.startedAt}
                    estimatedDuration={refinementProgress.estimatedDuration}
                  />
                )}
              </div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area - floating command bar style with margin */}
      <div className="flex-shrink-0 m-4">
        <form onSubmit={handleSubmit}>
          <div className="flex gap-2 items-end bg-white rounded-lg shadow-lg border border-slate-200 p-4">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask the AI to refine the plan..."
              disabled={isLoading}
              rows={1}
              className="flex-1 px-3 py-2 bg-transparent focus:outline-none disabled:bg-gray-50 resize-none min-h-[40px] max-h-[200px] overflow-y-auto text-sm"
            />
            {/* Keyboard shortcut hint */}
            <span className="text-xs text-gray-400 self-center mr-1 flex-shrink-0">↵</span>
            {isLoading ? (
              <button
                type="button"
                onClick={handleStop}
                className="p-2 text-white rounded-md bg-red-500 hover:bg-red-600 transition-colors flex items-center justify-center flex-shrink-0"
                title="Stop refinement"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="p-2 rounded-md transition-colors flex items-center justify-center flex-shrink-0 bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

export default RefinementChat;
