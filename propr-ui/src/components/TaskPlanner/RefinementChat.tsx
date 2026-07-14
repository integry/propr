import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Bot, User, Loader2, Square } from 'lucide-react';
import { ChatMessage } from '../../api/proprApi';
import type { RefinementProgress } from '../../hooks/usePlanRefinement';
import { useIsMobile } from '../../hooks/useIsMobile';
import { RefinementProgressBar } from './RefinementProgressBar';
import { ModelSelector } from './SetupWizardComponents';
import { useAgentsLoader } from './setupWizardHooks';
import { getModelDisplayName } from '../../utils/modelDisplay';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: Date;
}

interface RefinementChatProps {
  onSendMessage: (message: string, signal?: AbortSignal, generationModel?: string) => Promise<{ success: boolean; message: string; action?: 'modified' | 'answered' | 'both'; cancelled?: boolean }>;
  initialMessages?: ChatMessage[];
  onMessagesChange?: (messages: ChatMessage[]) => void;
  refinementProgress?: RefinementProgress;
  onStop?: () => Promise<void>;
  /** Model the plan was generated with; the default the switcher refines with. */
  defaultModel?: string | null;
  inputValueOverride?: string;
  isLoadingOverride?: boolean;
  sendButtonPressed?: boolean;
  sendButtonForceEnabled?: boolean;
  showStopButtonOverride?: boolean;
  syncInitialMessages?: boolean;
  disableSmoothAutoScroll?: boolean;
  disableAutoScroll?: boolean;
  stableComposerHeight?: number;
}

/** Human label for the plan's default model, shown as the switcher's default option. */
function defaultModelLabel(defaultModel?: string | null): string | undefined {
  if (!defaultModel) return undefined;
  const [maybeAgent, ...rest] = defaultModel.split(':');
  if (rest.length > 0) return `${maybeAgent} / ${getModelDisplayName(rest.join(':'))}`;
  return getModelDisplayName(defaultModel);
}

interface ChatMessageItemProps {
  message: Message;
  isLast: boolean;
  refinementProgress?: RefinementProgress;
}

const ChatMessageItem: React.FC<ChatMessageItemProps> = ({ message, isLast, refinementProgress }) => (
  <div
    className={`flex items-start pb-6 ${!isLast ? 'border-b border-slate-100' : ''}`}
  >
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
        {message.role === 'thinking' && refinementProgress?.startedAt && refinementProgress?.estimatedDuration && (
          <RefinementProgressBar
            startedAt={refinementProgress.startedAt}
            estimatedDuration={refinementProgress.estimatedDuration}
          />
        )}
      </div>
    </div>
  </div>
);

interface ChatInputFormProps {
  isMobile: boolean;
  effectiveInput: string;
  effectiveIsLoading: boolean;
  submitDisabled: boolean;
  showStopButton: boolean;
  sendButtonPressed: boolean;
  stableComposerHeight?: number;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: (e: React.FormEvent) => void;
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
  footer?: React.ReactNode;
}

const ChatInputForm: React.FC<ChatInputFormProps> = ({
  isMobile, effectiveInput, effectiveIsLoading, submitDisabled,
  showStopButton, sendButtonPressed, stableComposerHeight,
  textareaRef, onSubmit, onInputChange, onKeyDown, onStop, footer,
}) => (
  <div className={`flex-shrink-0 ${isMobile ? 'm-3' : 'm-4'}`}>
    <form onSubmit={onSubmit}>
      <div className={`flex gap-2 items-end bg-white rounded-lg shadow-lg border border-slate-200 ${isMobile ? 'p-3' : 'p-4'}`}>
        <textarea
          ref={textareaRef}
          value={effectiveInput}
          onChange={e => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask the AI to refine the plan..."
          disabled={effectiveIsLoading}
          rows={1}
          className={`flex-1 px-3 py-2 bg-transparent focus:outline-none disabled:bg-gray-50 resize-none min-h-[40px] overflow-y-auto text-sm ${isMobile ? 'max-h-[120px]' : 'max-h-[200px]'}`}
          style={stableComposerHeight === undefined ? undefined : { height: stableComposerHeight, minHeight: stableComposerHeight, maxHeight: stableComposerHeight }}
        />
        {!isMobile && <span className="text-xs text-gray-400 self-center mr-1 flex-shrink-0">↵</span>}
        {showStopButton ? (
          <button
            type="button"
            onClick={onStop}
            className="p-2 text-white rounded-md bg-red-500 hover:bg-red-600 transition-colors flex items-center justify-center flex-shrink-0"
            title="Stop refinement"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            type="submit"
            disabled={submitDisabled}
            className={`p-2 rounded-md transition-colors flex items-center justify-center flex-shrink-0 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed ${sendButtonPressed ? 'bg-indigo-700 shadow-inner' : 'bg-indigo-600'}`}
          >
            <Send size={16} />
          </button>
        )}
      </div>
      {footer && <div className="flex items-center gap-2 mt-2 px-1">{footer}</div>}
    </form>
  </div>
);

function initMessages(initialMessages: ChatMessage[] | undefined): Message[] {
  if (initialMessages && initialMessages.length > 0) {
    return initialMessages.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
  }
  return [];
}

function toMessages(chatMessages: ChatMessage[] | undefined): Message[] {
  return (chatMessages ?? []).map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
}

const ChatHeader: React.FC<{ showEmptySubtitle: boolean }> = ({ showEmptySubtitle }) => (
  <div className="px-4 py-3">
    <div className="flex items-center">
      <div className="w-10 flex-shrink-0 flex justify-center">
        <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center">
          <Bot size={16} className="text-white" />
        </div>
      </div>
      <h3 className="font-semibold text-gray-900 ml-3">Assistant</h3>
    </div>
    {showEmptySubtitle && <p className="text-xs text-gray-500 mt-0.5 ml-[52px]">Refine your plan through conversation</p>}
  </div>
);

const OnboardingCard: React.FC = () => (
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
);

const getMessageBubbleClass = (role: Message['role']): string => {
  if (role === 'user') return 'bg-white border border-indigo-100 text-slate-800 shadow-sm px-4 py-2 inline-block';
  if (role === 'thinking') return 'bg-slate-200 text-gray-600 italic p-3 w-full max-w-xs';
  return 'bg-transparent text-gray-800 inline-block';
};

const MessageIcon: React.FC<{ role: Message['role'] }> = ({ role }) => (
  <div
    className={`
      w-8 h-8 rounded-full flex items-center justify-center
      ${role === 'thinking' ? 'bg-gray-300' : role === 'assistant' ? 'bg-gray-700' : 'bg-white border border-slate-200'}
    `}
  >
    {role === 'user' ? (
      <User size={16} className="text-slate-600" />
    ) : role === 'thinking' ? (
      <Loader2 size={16} className="text-gray-600 animate-spin" />
    ) : (
      <Bot size={16} className="text-white" />
    )}
  </div>
);

const MessageRow: React.FC<{
  message: Message; isLast: boolean; refinementProgress?: RefinementProgress;
}> = ({ message, isLast, refinementProgress }) => (
  <div className={`flex items-start pb-6 ${isLast ? '' : 'border-b border-slate-100'}`}>
    <div className="w-10 flex-shrink-0 flex justify-center">
      <MessageIcon role={message.role} />
    </div>
    <div className="flex-1 min-w-0 ml-3">
      <div className={`rounded-lg ${getMessageBubbleClass(message.role)}`}>
        <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        {message.role === 'thinking' && refinementProgress?.startedAt && refinementProgress?.estimatedDuration && (
          <RefinementProgressBar
            startedAt={refinementProgress.startedAt}
            estimatedDuration={refinementProgress.estimatedDuration}
          />
        )}
      </div>
    </div>
  </div>
);

const getVisibleMessages = (syncInitialMessages: boolean, syncedMessages: Message[], messages: Message[]) => (
  syncInitialMessages ? syncedMessages : messages
);

export const RefinementChat: React.FC<RefinementChatProps> = ({ onSendMessage, initialMessages, onMessagesChange, refinementProgress, onStop, defaultModel, inputValueOverride, isLoadingOverride, sendButtonPressed = false, sendButtonForceEnabled = false, showStopButtonOverride, syncInitialMessages = false, disableSmoothAutoScroll = false, disableAutoScroll = false, stableComposerHeight }) => {
  const isMobile = useIsMobile();
  const agents = useAgentsLoader();
  const syncedMessages = useMemo<Message[]>(() => toMessages(initialMessages), [initialMessages]);
  const [messages, setMessages] = useState<Message[]>(() => initMessages(initialMessages));
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // null = refine with the plan's default model (server falls back to it);
  // a value overrides it for this and subsequent refinements.
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const effectiveInput = inputValueOverride ?? input;
  const effectiveIsLoading = isLoadingOverride ?? isLoading;
  const showStopButton = effectiveIsLoading && (showStopButtonOverride ?? true);
  const submitDisabled = !sendButtonForceEnabled && !effectiveInput.trim();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const visibleMessages = getVisibleMessages(syncInitialMessages, syncedMessages, messages);

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      if (stableComposerHeight !== undefined) {
        textarea.style.height = `${stableComposerHeight}px`;
        return;
      }
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [stableComposerHeight]);

  const scrollToBottom = useCallback(() => {
    if (disableAutoScroll) return;
    messagesEndRef.current?.scrollIntoView({ behavior: disableSmoothAutoScroll ? 'auto' : 'smooth' });
  }, [disableAutoScroll, disableSmoothAutoScroll]);

  useEffect(() => {
    scrollToBottom();
  }, [visibleMessages, scrollToBottom]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [effectiveInput, adjustTextareaHeight]);

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
    if (onStop) {
      try {
        await onStop();
      } catch (err) {
        console.error('Failed to abort refinement:', err);
      }
    }
  }, [onStop]);

  const buildEnrichedMessage = useCallback((userInstruction: string, conversationHistory: Message[]): string => {
    const parts: string[] = [];

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

    parts.push('## Current Instruction');
    parts.push(userInstruction);
    parts.push('');

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
    if (!effectiveInput.trim() || effectiveIsLoading) return;

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: effectiveInput.trim(),
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

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    onMessagesChange?.(toChatMessages(messagesWithUser));

    const enrichedMessage = buildEnrichedMessage(userMessage.content, messages);
    const result = await onSendMessage(enrichedMessage, abortController.signal, selectedModel || undefined);

    abortControllerRef.current = null;

    let assistantContent: string;
    if (result.cancelled) assistantContent = 'Refinement cancelled by user.';
    else if (result.success) assistantContent = result.message;
    else assistantContent = `Error: ${result.message}`;

    const assistantMessage: Message = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: assistantContent,
      timestamp: new Date()
    };

    const finalMessages = [...messagesWithUser, assistantMessage];
    setMessages(finalMessages);
    setIsLoading(false);

    onMessagesChange?.(toChatMessages(finalMessages));
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {!isMobile && <ChatHeader showEmptySubtitle={visibleMessages.length === 0} />}

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
        {visibleMessages.length === 0 && <OnboardingCard />}
        {visibleMessages.map((message, index) => (
          <MessageRow
            key={message.id}
            message={message}
            isLast={index === visibleMessages.length - 1}
            refinementProgress={refinementProgress}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <ChatInputForm
        isMobile={isMobile}
        effectiveInput={effectiveInput}
        effectiveIsLoading={effectiveIsLoading}
        submitDisabled={submitDisabled}
        showStopButton={showStopButton}
        sendButtonPressed={sendButtonPressed}
        stableComposerHeight={stableComposerHeight}
        textareaRef={textareaRef}
        onSubmit={handleSubmit}
        onInputChange={setInput}
        onKeyDown={handleKeyDown}
        onStop={handleStop}
        footer={agents.length > 0 ? (
          <>
            <span className="text-xs text-gray-500 flex-shrink-0">Refine with</span>
            <ModelSelector
              agents={agents}
              generationModel={selectedModel}
              onModelChange={setSelectedModel}
              modelName={defaultModelLabel(defaultModel)}
              disabled={effectiveIsLoading}
            />
          </>
        ) : undefined}
      />
    </div>
  );
};

export default RefinementChat;
