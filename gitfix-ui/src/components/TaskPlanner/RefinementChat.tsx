import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { ChatMessage } from '../../api/gitfixApi';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: Date;
}

interface RefinementChatProps {
  onSendMessage: (message: string) => Promise<{ success: boolean; message: string; action?: 'modified' | 'answered' | 'both' }>;
  initialMessages?: ChatMessage[];
  onMessagesChange?: (messages: ChatMessage[]) => void;
}

export const RefinementChat: React.FC<RefinementChatProps> = ({ onSendMessage, initialMessages, onMessagesChange }) => {
  const [messages, setMessages] = useState<Message[]>(() => {
    if (initialMessages && initialMessages.length > 0) {
      // Filter out any legacy welcome messages stored in the database
      const filteredMessages = initialMessages.filter(m =>
        !(m.role === 'assistant' && m.content.includes('I can help you refine this plan'))
      );
      if (filteredMessages.length > 0) {
        return filteredMessages.map(m => ({
          ...m,
          timestamp: new Date(m.timestamp)
        }));
      }
    }
    return [];
  });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

    // Save user message immediately
    onMessagesChange?.(toChatMessages(messagesWithUser));

    const result = await onSendMessage(userMessage.content);

    const assistantMessage: Message = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: result.success ? result.message : `Error: ${result.message}`,
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
      {/* Header - borderless, blends with sidebar */}
      <div className="px-4 py-3">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Bot size={18} style={{ color: 'rgb(29, 138, 138)' }} />
          AI Refinement Assistant
        </h3>
        <p className="text-xs text-gray-500 mt-0.5">Refine your plan through conversation</p>
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
                  rounded-lg inline-block
                  ${message.role === 'user'
                    ? 'bg-white border border-slate-200 text-slate-800 shadow-sm px-4 py-2'
                    : message.role === 'thinking'
                      ? 'bg-slate-200 text-gray-600 italic p-3'
                      : 'bg-transparent text-gray-800'
                  }
                `}
              >
                <p className="text-sm whitespace-pre-wrap">{message.content}</p>
              </div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area - floating command bar style with margin */}
      <div className="flex-shrink-0 m-4">
        <form onSubmit={handleSubmit}>
          <div className="flex gap-2 items-end bg-white rounded-lg shadow-sm border border-slate-200 p-4">
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
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="p-2 text-white rounded-md disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: (!input.trim() || isLoading) ? undefined : 'rgb(29, 138, 138)' }}
              onMouseEnter={(e) => { if (input.trim() && !isLoading) e.currentTarget.style.backgroundColor = 'rgb(24, 118, 118)'; }}
              onMouseLeave={(e) => { if (input.trim() && !isLoading) e.currentTarget.style.backgroundColor = 'rgb(29, 138, 138)'; }}
            >
              {isLoading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Send size={16} />
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default RefinementChat;
