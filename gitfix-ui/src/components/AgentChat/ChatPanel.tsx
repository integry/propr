import React, { useState, useRef, useEffect, useMemo } from 'react';
import { AgentConfig, chatWithAgents, ChatResult, ChatQuery } from '../../api/gitfixApi';
import { MODEL_INFO_MAP, AgentType } from '../../config/modelDefinitions';

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
    <div className="flex flex-col h-full bg-white rounded-lg shadow border border-gray-200">
      {/* Header & Controls */}
      <div className="p-4 border-b border-gray-200 bg-gray-50 rounded-t-lg flex-shrink-0">
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-semibold text-gray-700">Test Agents</h3>
          <button
            onClick={() => setMessages([])}
            className="text-sm text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-200 transition-colors"
            title="Clear History"
          >
            Clear
          </button>
        </div>
        <div className="flex gap-2 flex-wrap">
          {agentModelOptions.length === 0 ? (
            <p className="text-sm text-gray-500">No enabled models available. Enable agents and models in the configuration.</p>
          ) : (
            agentModelOptions.map(option => {
              const isSelected = selectedKeys.includes(option.key);
              return (
                <button
                  key={option.key}
                  onClick={() => toggleSelection(option.key)}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-all duration-200 flex items-center gap-1.5 ${
                    isSelected
                      ? selectedBadgeColors[option.agentType]
                      : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100 hover:border-gray-300 hover:text-gray-600'
                  }`}
                >
                  {isSelected && (
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                  {option.agentAlias} ({option.modelName})
                </button>
              );
            })
          )}
        </div>
        {selectedKeys.length === 0 && agentModelOptions.length > 0 && (
          <p className="text-xs text-amber-600 mt-2">Select at least one model to start chatting</p>
        )}
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="text-center text-gray-400 py-8">
            <p>No messages yet. Start a conversation to test your agents.</p>
          </div>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'user' ? (
              <div className="bg-blue-600 text-white px-4 py-2 rounded-lg max-w-[80%]">
                {msg.content}
              </div>
            ) : (
              <div className="flex gap-4 w-full overflow-x-auto pb-2">
                {msg.results?.map((res, rIdx) => (
                  <div key={rIdx} className="flex-1 min-w-[250px] bg-gray-100 rounded-lg p-3 border border-gray-200 relative flex flex-col">
                    <div className="text-xs font-bold text-gray-500 mb-1 border-b border-gray-200 pb-1 flex justify-between">
                      <span>{res.agentAlias}</span>
                      <span className="text-gray-400">{res.model}</span>
                    </div>
                    <div className="text-sm text-gray-800 whitespace-pre-wrap flex-1 pb-6">
                      {res.error ? <span className="text-red-500">{res.error}</span> : res.response}
                    </div>
                    <div className="absolute bottom-2 right-3 text-xs text-gray-400 bg-gray-100 px-1">
                      {res.durationMs}ms
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-lg p-3 border border-gray-200">
              <div className="text-sm text-gray-500 animate-pulse">Thinking...</div>
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="p-4 border-t border-gray-200 flex-shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Type a message to test..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || selectedKeys.length === 0}
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim() || selectedKeys.length === 0}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatPanel;
