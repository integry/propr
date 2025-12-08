import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: Date;
}

interface RefinementChatProps {
  onSendMessage: (message: string) => Promise<{ success: boolean; message: string }>;
}

export const RefinementChat: React.FC<RefinementChatProps> = ({ onSendMessage }) => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: 'I can help you refine this plan. Try asking me to:\n- "Make the testing task more detailed"\n- "Split the backend task into two"\n- "Add error handling to all tasks"',
      timestamp: new Date()
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

    setMessages(prev => [...prev, userMessage, thinkingMessage]);
    setInput('');
    setIsLoading(true);

    const result = await onSendMessage(userMessage.content);

    setMessages(prev => {
      const filtered = prev.filter(m => m.id !== 'thinking');
      return [...filtered, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: result.success ? result.message : `Error: ${result.message}`,
        timestamp: new Date()
      }];
    });
    setIsLoading(false);
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="p-3 border-b bg-white">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Bot size={18} className="text-indigo-600" />
          AI Refinement Assistant
        </h3>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map(message => (
          <div
            key={message.id}
            className={`flex items-start gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
          >
            <div className={`
              flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center
              ${message.role === 'user' ? 'bg-indigo-600' : message.role === 'thinking' ? 'bg-gray-300' : 'bg-gray-700'}
            `}>
              {message.role === 'user' ? (
                <User size={16} className="text-white" />
              ) : message.role === 'thinking' ? (
                <Loader2 size={16} className="text-gray-600 animate-spin" />
              ) : (
                <Bot size={16} className="text-white" />
              )}
            </div>
            <div className={`
              max-w-[80%] rounded-lg p-3
              ${message.role === 'user' 
                ? 'bg-indigo-600 text-white' 
                : message.role === 'thinking'
                  ? 'bg-gray-200 text-gray-600 italic'
                  : 'bg-white border border-gray-200 text-gray-800'
              }
            `}>
              <p className="text-sm whitespace-pre-wrap">{message.content}</p>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="p-4 border-t bg-white">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask the AI to refine the plan..."
            disabled={isLoading}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:bg-gray-100"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isLoading ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Send size={18} />
            )}
          </button>
        </div>
      </form>
    </div>
  );
};

export default RefinementChat;
