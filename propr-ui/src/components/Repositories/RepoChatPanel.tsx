import React, { useState, useRef, useEffect } from 'react';
import { User, Bot, Send, Loader2 } from 'lucide-react';

/**
 * Represents a single message in the chat history.
 */
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface RepoChatPanelProps {
  /** Callback invoked when the user sends a message */
  onSendMessage: (message: string) => Promise<string | void>;
  /** Initial messages to populate the chat */
  initialMessages?: Message[];
  /** Placeholder text for the input */
  placeholder?: string;
  /** Whether the panel is disabled */
  disabled?: boolean;
  /** Repository name to display in empty state */
  repositoryName?: string;
}

const RepoChatPanel: React.FC<RepoChatPanelProps> = ({
  onSendMessage,
  initialMessages = [],
  placeholder = 'Ask a question about this repository...',
  disabled = false,
  repositoryName,
}) => {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

    try {
      const response = await onSendMessage(trimmedInput);

      // Add assistant message if a response is returned
      if (response) {
        const assistantMessage: Message = {
          id: generateId(),
          role: 'assistant',
          content: response,
          timestamp: Date.now(),
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
          <div key={msg.id} className="flex items-start">
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
              <div
                className={`inline-block px-4 py-2 rounded-lg ${
                  msg.role === 'user'
                    ? 'bg-white border border-indigo-100 text-slate-800 shadow-sm'
                    : 'bg-white border border-gray-200 text-gray-800'
                }`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
              <div className="mt-1 text-[10px] text-gray-400">
                {new Date(msg.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          </div>
        ))}

        {/* Loading state */}
        {isLoading && (
          <div className="flex items-start">
            <div className="w-10 flex-shrink-0 flex justify-center">
              <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
                <Loader2 size={16} className="text-white animate-spin" />
              </div>
            </div>
            <div className="flex-1 min-w-0 ml-3">
              <div className="inline-block bg-gray-100 text-gray-600 px-4 py-2 rounded-lg">
                <p className="text-sm animate-pulse">Thinking...</p>
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
