import React, { useState, useRef, useEffect } from 'react';
import { AgentConfig, chatWithAgents, ChatResult } from '../../api/gitfixApi';

interface ChatPanelProps {
  agents: AgentConfig[];
}

interface Message {
  role: 'user' | 'assistant';
  content?: string;
  results?: ChatResult[];
  timestamp: number;
}

const ChatPanel: React.FC<ChatPanelProps> = ({ agents }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-select first agent if none selected
  useEffect(() => {
    if (agents.length > 0 && selectedAgentIds.length === 0) {
      setSelectedAgentIds([agents[0].id]);
    }
  }, [agents, selectedAgentIds.length]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || selectedAgentIds.length === 0) return;

    const userMsg: Message = { role: 'user', content: input, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    setInput('');

    try {
      // Build Context (simplified string of past messages)
      const context = messages.map(m =>
        m.role === 'user' ? `User: ${m.content}` : `Assistant: (Previous response hidden)`
      ).join('\n');

      const queries = selectedAgentIds.map(id => ({ agentId: id }));

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

  const enabledAgents = agents.filter(a => a.enabled);

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] bg-white rounded-lg shadow border border-gray-200">
      {/* Header & Controls */}
      <div className="p-4 border-b border-gray-200 bg-gray-50 rounded-t-lg">
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
          {enabledAgents.length === 0 ? (
            <p className="text-sm text-gray-500">No enabled agents available. Enable agents in the configuration.</p>
          ) : (
            enabledAgents.map(agent => (
              <button
                key={agent.id}
                onClick={() => setSelectedAgentIds(prev =>
                  prev.includes(agent.id) ? prev.filter(id => id !== agent.id) : [...prev, agent.id]
                )}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  selectedAgentIds.includes(agent.id)
                    ? 'bg-blue-100 border-blue-300 text-blue-800'
                    : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                {agent.alias} ({agent.type})
              </button>
            ))
          )}
        </div>
        {selectedAgentIds.length === 0 && enabledAgents.length > 0 && (
          <p className="text-xs text-amber-600 mt-2">Select at least one agent to start chatting</p>
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
                  <div key={rIdx} className="flex-1 min-w-[250px] bg-gray-100 rounded-lg p-3 border border-gray-200">
                    <div className="text-xs font-bold text-gray-500 mb-1 border-b border-gray-200 pb-1 flex justify-between">
                      <span>{res.agentAlias}</span>
                      <span className="text-gray-400">{res.model}</span>
                    </div>
                    <div className="text-sm text-gray-800 whitespace-pre-wrap mb-2">
                      {res.error ? <span className="text-red-500">{res.error}</span> : res.response}
                    </div>
                    <div className="text-xs text-right text-gray-400">
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
      <div className="p-4 border-t border-gray-200">
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Type a message to test..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || selectedAgentIds.length === 0}
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim() || selectedAgentIds.length === 0}
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
