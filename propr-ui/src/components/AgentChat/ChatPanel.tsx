import { formatModelName } from '../../utils/modelDisplay';
import React, { useRef, useEffect, useMemo } from 'react';
import { AgentConfig, ChatQuery } from '../../api/proprApi';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';
import { ProviderLogo } from '../ui/ProviderLogo';
import { Bot, Layers3, Send, User } from 'lucide-react';
import type { SyntheticAgentConfig } from '@propr/shared';
import ModelSelector, {
  type AgentModelOption,
  type AgentModelSelection,
} from './ModelSelector';
import type { PlaygroundSession } from './usePlaygroundSession';

export type { AgentModelSelection } from './ModelSelector';

interface ChatPanelProps {
  agents: AgentConfig[];
  syntheticAgents?: SyntheticAgentConfig[];
  selectedModels: AgentModelSelection[];
  onSelectedModelsChange: (selectedModels: AgentModelSelection[]) => void;
  /** Conversation state owned outside this view so layouts can share it. */
  session: PlaygroundSession;
  disabled?: boolean;
}

const isSameAgentModel = (
  left: AgentModelSelection,
  right: AgentModelSelection,
) => left.agentId === right.agentId && left.modelId === right.modelId;

const haveSameSelections = (
  left: AgentModelSelection[],
  right: AgentModelSelection[]
) => (
  left.length === right.length
  && left.every((selection, index) => isSameAgentModel(selection, right[index]))
);

const ChatPanel: React.FC<ChatPanelProps> = ({
  agents,
  syntheticAgents = [],
  selectedModels,
  onSelectedModelsChange,
  session,
  disabled = false
}) => {
  const { messages, input, setInput, isLoading } = session;
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Build list of all enabled agent+model combinations
  const agentModelOptions = useMemo(() => {
    const options: AgentModelOption[] = [];
    agents.filter(a => a.enabled).forEach(agent => {
      agent.supportedModels.forEach(modelId => {
        const modelInfo = MODEL_INFO_MAP[modelId];
        options.push({
          agentId: agent.id,
          agentAlias: agent.alias,
          modelId: modelId,
          modelName: modelInfo?.name || formatModelName(modelId)
        });
      });
    });
    syntheticAgents.filter(pool => pool.enabled).forEach(pool => {
      pool.models.filter(model => model.enabled).forEach(model => {
        options.push({
          agentId: pool.id,
          syntheticConfigId: pool.id,
          agentAlias: pool.alias,
          modelId: model.id,
          modelName: model.displayName || formatModelName(model.id),
        });
      });
    });
    return options;
  }, [agents, syntheticAgents]);

  // Keep selections limited to combinations exposed by the Playground. If an
  // agent is disabled or removed, fall back to the first available option.
  useEffect(() => {
    const availableSelections = selectedModels.filter(selection =>
      agentModelOptions.some(option => isSameAgentModel(selection, option))
    );
    const nextSelections = availableSelections.length > 0
      ? availableSelections
      : agentModelOptions.length > 0
        ? [{
            agentId: agentModelOptions[0].agentId,
            modelId: agentModelOptions[0].modelId
          }]
        : [];

    if (!haveSameSelections(selectedModels, nextSelections)) {
      onSelectedModelsChange(nextSelections);
    }
  }, [agentModelOptions, onSelectedModelsChange, selectedModels]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    // When the panel is too short for everything and scrolls as a whole, also
    // bring the latest exchange into view above the pinned composer.
    if (panelRef.current && messages.length > 0) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim() || selectedModels.length === 0 || disabled) return;

    // Build queries with agent+model combinations
    const queries: ChatQuery[] = selectedModels.map(selection => {
      const option = agentModelOptions.find(candidate => isSameAgentModel(candidate, selection));
      return {
        agentId: selection.agentId,
        ...(option?.syntheticConfigId ? { syntheticConfigId: option.syntheticConfigId } : {}),
        model: selection.modelId,
      };
    });
    void session.send(queries);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    // Normally only the transcript scrolls. When the available height (after
    // native chrome and the fixed mobile navigation) cannot hold the model
    // selector, a minimal transcript and the composer, the panel itself
    // scrolls and the composer stays pinned to its bottom edge, so it is never
    // clipped or left under the navigation. The panel is a size container so
    // its parts can tighten their padding when the panel itself is short.
    <div
      ref={panelRef}
      className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden overscroll-contain bg-[#F8FAFC] [container-type:size]"
      data-testid="ai-agents-playground-panel"
    >
      <ModelSelector
        options={agentModelOptions}
        selectedModels={selectedModels}
        onSelectedModelsChange={onSelectedModelsChange}
        onClear={session.clear}
      />

      {/* Messages Area - Studio Assistant styling */}
      <div
        className="launcher-docked-transcript min-h-[var(--launcher-docked-transcript-min-height,6rem)] flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 pb-3 sm:px-4 sm:pb-4"
        ref={scrollRef}
        data-testid="ai-agents-playground-transcript"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: '#d1d5db transparent'
        }}
      >
        {messages.length === 0 && (
          <div className="py-4 sm:px-2">
            <p className="text-sm text-gray-500">
              Test your agents by sending messages. Select one or more models above to compare responses side by side.
            </p>
          </div>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className="flex items-start">
            {msg.role === 'user' ? (
              <>
                {/* Fixed 40px icon column for gutter alignment */}
                <div className="flex w-8 flex-shrink-0 justify-center sm:w-10">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white sm:h-8 sm:w-8">
                    <User size={16} className="text-slate-600" />
                  </div>
                </div>
                {/* User message - white card with shadow */}
                <div className="ml-2 min-w-0 flex-1 sm:ml-3">
                  <div className="inline-block max-w-full rounded-lg border border-indigo-100 bg-white px-3 py-2 text-slate-800 shadow-sm sm:px-4">
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Fixed 40px icon column for gutter alignment */}
                <div className="flex w-8 flex-shrink-0 justify-center pt-1 sm:w-10">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-700 sm:h-8 sm:w-8">
                    <Bot size={16} className="text-white" />
                  </div>
                </div>
                {/* AI responses - transparent background, horizontal scroll for multiple */}
                <div className="ml-2 min-w-0 flex-1 sm:ml-3">
                  <div className="scrollbar-stealth flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 sm:snap-none">
                    {msg.results?.map((res, rIdx) => (
                      <div key={rIdx} className={`relative flex min-w-full max-w-full snap-start flex-col bg-transparent sm:min-w-[220px] sm:max-w-[300px] ${rIdx > 0 ? 'border-l border-slate-200 pl-3' : ''}`}>
                        <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-gray-500">
                          {res.virtualAgentAlias
                            ? <Layers3 className="h-3 w-3" aria-hidden="true" />
                            : <ProviderLogo provider={res.agentAlias} className="w-3 h-3" />}
                          <span className="flex-shrink-0">{res.virtualAgentAlias || res.agentAlias}</span>
                          <span className="truncate text-gray-400">· {formatModelName(res.virtualModel || res.model || '')}</span>
                        </div>
                        {res.physicalAgentAlias && (
                          <div className="mb-1 flex min-w-0 items-center gap-1 text-[10px] text-slate-500">
                            <ProviderLogo provider={res.physicalAgentAlias} className="h-3 w-3" />
                            <span className="truncate">Executed by {res.physicalAgentAlias} · {res.physicalModel}</span>
                            {res.attemptNumber && <span>· attempt {res.attemptNumber}</span>}
                          </div>
                        )}
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
            <div className="flex w-8 flex-shrink-0 justify-center sm:w-10">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-300 sm:h-8 sm:w-8">
                <Bot size={16} className="text-gray-600 animate-pulse" />
              </div>
            </div>
            <div className="ml-2 min-w-0 flex-1 sm:ml-3">
              <div className="bg-slate-200 text-gray-600 italic p-3 rounded-lg inline-block">
                <p className="text-sm animate-pulse">Thinking...</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating Input Bar - visually detached from bottom. The page already
          reserves the mobile navigation's height; only a shown Voice briefing
          launcher (above the mobile navigation, or at the desktop window's
          corner) needs extra room: above it or, in a short panel wide enough
          for the composer and the launcher side by side, beside it. */}
      <div className="launcher-docked-composer sticky bottom-0 z-10 flex-shrink-0 bg-[#F8FAFC] pb-[max(0.75rem,var(--floating-launcher-clearance))] pl-3 pr-[max(0.75rem,var(--floating-launcher-inline-reserve,0px))] pt-3 md:pb-[max(1rem,var(--floating-launcher-clearance))] md:pl-4 md:pr-[max(1rem,var(--floating-launcher-inline-reserve,0px))] md:pt-[var(--launcher-docked-composer-block-start,1rem)] [@container(max-height:14rem)]:pb-[max(0.5rem,var(--floating-launcher-clearance))] [@container(max-height:14rem)]:pt-2">
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-2 shadow-md sm:items-end sm:gap-2 sm:p-[var(--launcher-docked-composer-box-padding,1rem)]">
          <input
            type="text"
            className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm focus:outline-none sm:px-3"
            placeholder="Type a message to test..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || selectedModels.length === 0 || disabled}
          />
          {/* Keyboard shortcut hint */}
          <span className="mr-1 hidden flex-shrink-0 self-center text-xs text-gray-400 md:block">↵</span>
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim() || selectedModels.length === 0 || disabled}
            aria-label="Send message"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-indigo-600 text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatPanel;
