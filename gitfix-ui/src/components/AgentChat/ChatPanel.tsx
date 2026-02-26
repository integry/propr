import React, { useState, useRef, useEffect, useMemo } from 'react';
import { AgentConfig, chatWithAgents, ChatResult, ChatQuery } from '../../api/gitfixApi';
import { MODEL_INFO_MAP, AgentType } from '../../config/modelDefinitions';
import { ProviderLogo } from '../ui/ProviderLogo';
import { Bot, User, Send } from 'lucide-react';

// Enhanced badge colors for selected state - more visually prominent
const selectedBadgeColors: Record<AgentType, string> = {
  claude: 'bg-orange-500 text-white border-orange-600 shadow-md ring-2 ring-orange-300',
  codex: 'bg-green-500 text-white border-green-600 shadow-md ring-2 ring-green-300',
  gemini: 'bg-blue-500 text-white border-blue-600 shadow-md ring-2 ring-blue-300'
};

interface ChatPanelProps {
  agents: AgentConfig[];
}

interface Message {
  role: 'user' | 'assistant';
  content?: string;
  results?: ChatResult[];
  timestamp: number;
}

// Represents an agent+model combination for selection
interface AgentModelOption {
  agentId: string;
  agentAlias: string;
  agentType: AgentType;
  modelId: string;
  modelName: string;
  key: string; // unique key: agentId:modelId
}

const ChatPanel: React.FC<ChatPanelProps> = ({ agents }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Build list of all enabled agent+model combinations
  const agentModelOptions = useMemo(() => {
    const options: AgentModelOption[] = [];
    agents.filter(a => a.enabled).forEach(agent => {
      agent.supportedModels.forEach(modelId => {
        const modelInfo = MODEL_INFO_MAP[modelId];
        options.push({
          agentId: agent.id,
          agentAlias: agent.alias,
          agentType: agent.type as AgentType,
          modelId: modelId,
          modelName: modelInfo?.name || modelId,
          key: `${agent.id}:${modelId}`
        });
      });
    });
    return options;
  }, [agents]);

  // Auto-select first option if none selected
  useEffect(() => {
    if (agentModelOptions.length > 0 && selectedKeys.length === 0) {
      setSelectedKeys([agentModelOptions[0].key]);
    }
  }, [agentModelOptions, selectedKeys.length]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || selectedKeys.length === 0) return;

    const userMsg: Message = { role: 'user', content: input, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    setInput('');

    try {
      // Build Context (simplified string of past messages)
      const context = messages.map(m =>
        m.role === 'user' ? `User: ${m.content}` : `Assistant: (Previous response hidden)`
      ).join('\n');

      // Build queries with agent+model combinations
      const queries: ChatQuery[] = selectedKeys.map(key => {
        const [agentId, modelId] = key.split(':');
        return { agentId, model: modelId };
      });

      const { results } = await chatWithAgents(queries, userMsg.content!, context);

      const assistantMsg: Message = {
        role: 'assistant',
        results: results,
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      console.error(err);
      const errorMsg: Message = {
        role: 'assistant',
        results: [{
          agentId: 'error',
          agentAlias: 'System',
          model: 'N/A',
          error: (err as Error).message || 'Failed to get response',
          durationMs: 0
        }],
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, errorMsg]);
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

  const toggleSelection = (key: string) => {
    setSelectedKeys(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  return (
    <div className="flex flex-col h-full bg-[#F8FAFC]">
      {/* Header with Assistant styling */}
      <div className="px-4 py-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            {/* Fixed 40px icon column to match message gutter alignment */}
            <div className="w-10 flex-shrink-0 flex justify-center">
              <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
                <Bot size={16} className="text-white" />
              </div>
            </div>
            <h3 className="font-semibold text-gray-900 ml-3">Assistant</h3>
          </div>
          <button
            onClick={() => setMessages([])}
            className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-200/50 transition-colors"
            title="Clear History"
          >
            Clear
          </button>
        </div>
        {/* Compact model selector with tiny chips - wraps to multiple rows */}
        <div className="mt-3 ml-[52px]">
          <div className="flex flex-wrap gap-1.5">
            {agentModelOptions.length === 0 ? (
              <p className="text-[10px] text-gray-500">No enabled models available.</p>
            ) : (
              agentModelOptions.map(option => {
                const isSelected = selectedKeys.includes(option.key);
                return (
                  <button
                    key={option.key}
                    onClick={() => toggleSelection(option.key)}
                    className={`px-2 py-0.5 text-[10px] rounded-full border transition-all duration-200 flex items-center gap-1 whitespace-nowrap ${
                      isSelected
                        ? selectedBadgeColors[option.agentType]
                        : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100 hover:border-gray-300 hover:text-gray-600'
                    }`}
                  >
                    <ProviderLogo provider={option.agentAlias} className="w-3 h-3" />
                    {option.modelName}
                  </button>
                );
              })
            )}
          </div>
          {selectedKeys.length === 0 && agentModelOptions.length > 0 && (
            <p className="text-[10px] text-amber-600 mt-1">Select at least one model to start chatting</p>
          )}
        </div>
      </div>

      {/* Messages Area - Studio Assistant styling */}
      <div
        className="flex-1 overflow-y-auto px-4 pb-4 space-y-4"
        ref={scrollRef}
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: '#d1d5db transparent'
        }}
      >
        {messages.length === 0 && (
          <div className="ml-[52px]">
            <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm">
              <p className="text-sm text-gray-700">
                Test your agents by sending messages. Select one or more models above to compare responses side by side.
              </p>
            </div>
          </div>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className="flex items-start">
            {msg.role === 'user' ? (
              <>
                {/* Fixed 40px icon column for gutter alignment */}
                <div className="w-10 flex-shrink-0 flex justify-center">
                  <div className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center">
                    <User size={16} className="text-slate-600" />
                  </div>
                </div>
                {/* User message - white card with shadow */}
                <div className="flex-1 min-w-0 ml-3">
                  <div className="bg-white border border-indigo-100 text-slate-800 shadow-sm px-4 py-2 rounded-lg inline-block">
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Fixed 40px icon column for gutter alignment */}
                <div className="w-10 flex-shrink-0 flex justify-center pt-1">
                  <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
                    <Bot size={16} className="text-white" />
                  </div>
                </div>
                {/* AI responses - transparent background, horizontal scroll for multiple */}
                <div className="flex-1 min-w-0 ml-3">
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {msg.results?.map((res, rIdx) => (
                      <div key={rIdx} className="flex-1 min-w-[220px] max-w-[300px] bg-transparent relative flex flex-col">
                        <div className="text-[10px] font-medium text-gray-500 mb-1 flex items-center gap-1.5">
                          <ProviderLogo provider={res.agentAlias} className="w-3 h-3" />
                          <span>{res.agentAlias}</span>
                          <span className="text-gray-400">· {res.model}</span>
                        </div>
                        <div className="text-sm text-gray-800 whitespace-pre-wrap">
                          {res.error ? <span className="text-red-500">{res.error}</span> : res.response}
                        </div>
                        <div className="text-[10px] text-gray-400 mt-1">
                          {res.durationMs}ms
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-start">
            <div className="w-10 flex-shrink-0 flex justify-center">
              <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center">
                <Bot size={16} className="text-gray-600 animate-pulse" />
              </div>
            </div>
            <div className="flex-1 min-w-0 ml-3">
              <div className="bg-slate-200 text-gray-600 italic p-3 rounded-lg inline-block">
                <p className="text-sm animate-pulse">Thinking...</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating Input Bar - visually detached from bottom */}
      <div className="flex-shrink-0 p-4">
        <div className="flex gap-2 items-end bg-white rounded-lg shadow-md border border-slate-200 p-4">
          <input
            type="text"
            className="flex-1 bg-transparent px-3 py-2 focus:outline-none text-sm"
            placeholder="Type a message to test..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || selectedKeys.length === 0}
          />
          {/* Keyboard shortcut hint */}
          <span className="text-xs text-gray-400 self-center mr-1 flex-shrink-0">↵</span>
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim() || selectedKeys.length === 0}
            className="p-2 rounded-md transition-colors flex items-center justify-center flex-shrink-0 bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatPanel;
