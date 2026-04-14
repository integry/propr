import React, { useState, useCallback, useEffect } from 'react';
import { MessageSquareText, Sparkles, Book, ListTodo } from 'lucide-react';
import RepoChatPanel, { ChatResponse, Message } from './RepoChatPanel';
import RepoImprovementsPanel, { ImprovementCategory, SuggestionItem, GenerateSuggestionsResult } from './RepoImprovementsPanel';
import RepoBrowsePanel from './RepoBrowsePanel';
import RepoTodosPanel from './RepoTodosPanel';
import {
  chatWithRepository,
  ChatMessage,
  getChatMessages,
  saveChatMessages,
  deleteChatMessage,
  clearChatMessages,
  PersistedChatMessage
} from '../../api/repoChatApi';
import { generateRepoImprovements } from '../../api/repoImprovementsApi';

type ActionTab = 'chat' | 'improve' | 'browse' | 'todos';

interface TabButtonProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ label, icon, isActive, onClick }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest transition-all border-t-2 -mt-px
      ${isActive
        ? 'text-teal-600 border-t-teal-500 bg-white'
        : 'text-slate-400 border-t-transparent hover:text-slate-600 hover:bg-slate-100/50'
      }`}
  >
    {icon}
    <span>{label}</span>
  </button>
);

export interface RepoActionContainerProps {
  selectedRepo: {
    id: string;
    name: string;
    alias?: string;
    baseBranch?: string;
  } | null;
  initialTab?: ActionTab;
}

const RepoActionContainer: React.FC<RepoActionContainerProps> = ({ selectedRepo, initialTab }) => {
  const [activeTab, setActiveTab] = useState<ActionTab>(initialTab || 'chat');
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  // Switch tab when initialTab changes (e.g. from navigation state)
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // Load persisted messages when repository changes
  useEffect(() => {
    if (!selectedRepo) {
      setChatMessages([]);
      setSuggestions([]);
      return;
    }

    const loadMessages = async () => {
      setIsLoadingMessages(true);
      try {
        const messages = await getChatMessages(selectedRepo.name);
        setChatMessages(messages as Message[]);
      } catch (error) {
        console.error('Failed to load chat messages:', error);
        setChatMessages([]);
      } finally {
        setIsLoadingMessages(false);
      }
    };

    loadMessages();
    setSuggestions([]);
  }, [selectedRepo]);

  // Build chat history for API from messages
  const chatHistory: ChatMessage[] = chatMessages.map((msg) => ({
    role: msg.role,
    content: msg.content
  }));

  const handleSendMessage = useCallback(async (message: string, model: string, contextLevel: number): Promise<ChatResponse> => {
    if (!selectedRepo) {
      throw new Error('No repository selected');
    }

    const branch = selectedRepo.baseBranch || 'HEAD';

    // Create user message
    const userMessage: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: 'user',
      content: message,
      timestamp: Date.now()
    };

    // Add user message to local state
    setChatMessages((prev) => [...prev, userMessage]);

    try {
      const response = await chatWithRepository({
        repository: selectedRepo.name,
        branch,
        prompt: message,
        history: chatHistory,
        model,
        contextLevel
      });

      if (response.error) {
        throw new Error(response.error);
      }

      // Create assistant message
      const assistantMessage: Message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        role: 'assistant',
        content: response.reply,
        timestamp: Date.now(),
        metadata: {
          estimatedDurationMs: response.estimatedDurationMs,
          actualDurationMs: response.actualDurationMs,
          isHistoricalEstimate: response.isHistoricalEstimate,
        }
      };

      // Add assistant message to local state
      setChatMessages((prev) => [...prev, assistantMessage]);

      // Persist both messages to backend
      try {
        await saveChatMessages(selectedRepo.name, [userMessage, assistantMessage] as PersistedChatMessage[]);
      } catch (persistError) {
        console.error('Failed to persist chat messages:', persistError);
      }

      // Return response with metadata for timing display
      return {
        reply: response.reply,
        metadata: assistantMessage.metadata
      };
    } catch (error) {
      // Try to persist the user message even on error
      try {
        await saveChatMessages(selectedRepo.name, [userMessage] as PersistedChatMessage[]);
      } catch (persistError) {
        console.error('Failed to persist user message:', persistError);
      }
      throw error;
    }
  }, [selectedRepo, chatHistory]);

  // Handle deleting a single message
  const handleDeleteMessage = useCallback(async (messageId: string) => {
    if (!selectedRepo) return;

    // Optimistically remove from local state
    setChatMessages((prev) => prev.filter((msg) => msg.id !== messageId));

    // Delete from backend
    try {
      await deleteChatMessage(messageId);
    } catch (error) {
      console.error('Failed to delete message:', error);
      // Could restore the message on error, but for simplicity we'll just log
    }
  }, [selectedRepo]);

  // Handle clearing all messages
  const handleClearMessages = useCallback(async () => {
    if (!selectedRepo) return;

    // Optimistically clear local state
    setChatMessages([]);

    // Clear from backend
    try {
      await clearChatMessages(selectedRepo.name);
    } catch (error) {
      console.error('Failed to clear messages:', error);
    }
  }, [selectedRepo]);

  const handleToggleSuggestion = useCallback((index: number) => {
    setSuggestions((prev) =>
      prev.map((suggestion, i) =>
        i === index
          ? { ...suggestion, isSelected: !suggestion.isSelected }
          : suggestion
      )
    );
  }, []);

  if (!selectedRepo) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8">
          <div className="text-gray-300 mb-2">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <p className="text-sm text-gray-400">
            Select a repository to view details
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#F8FAFC]">
      {/* Tab Header - flush against top border */}
      <div className="flex items-stretch border-b border-slate-200 bg-[#F8FAFC]">
        <div className="flex items-stretch">
          <TabButton
            label="Chat"
            icon={<MessageSquareText className="h-3 w-3" />}
            isActive={activeTab === 'chat'}
            onClick={() => setActiveTab('chat')}
          />
          <TabButton
            label="Improve"
            icon={<Sparkles className="h-3 w-3" />}
            isActive={activeTab === 'improve'}
            onClick={() => setActiveTab('improve')}
          />
          <TabButton
            label="Browse"
            icon={<Book className="h-3 w-3" />}
            isActive={activeTab === 'browse'}
            onClick={() => setActiveTab('browse')}
          />
          <TabButton
            label="To-Dos"
            icon={<ListTodo className="h-3 w-3" />}
            isActive={activeTab === 'todos'}
            onClick={() => setActiveTab('todos')}
          />
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0">
        {activeTab === 'chat' && (
          <RepoChatPanel
            onSendMessage={handleSendMessage}
            messages={chatMessages}
            onDeleteMessage={handleDeleteMessage}
            onClearMessages={handleClearMessages}
            repositoryName={selectedRepo.alias || selectedRepo.name}
            disabled={isLoadingMessages}
          />
        )}
        {activeTab === 'improve' && (
          <RepoImprovementsPanel
            repositoryName={selectedRepo.alias || selectedRepo.name}
            repositoryId={selectedRepo.name}
            suggestions={suggestions}
            onToggleSuggestion={handleToggleSuggestion}
            onGenerateSuggestions={async (params: {
              categories: ImprovementCategory[];
              customPrompt: string;
              referenceRepoId: string | null;
              model: string;
              contextLevel: number;
            }): Promise<GenerateSuggestionsResult | void> => {
              const branch = selectedRepo.baseBranch || 'HEAD';
              const response = await generateRepoImprovements({
                repository: selectedRepo.name,
                branch,
                categories: params.categories,
                customPrompt: params.customPrompt || undefined,
                referenceRepoId: params.referenceRepoId,
                model: params.model,
                contextLevel: params.contextLevel,
              });

              if (response.error) {
                throw new Error(response.error);
              }

              // Transform API suggestions into SuggestionItems with selection state
              if (response.suggestions) {
                const suggestionItems: SuggestionItem[] = response.suggestions.map(
                  (suggestion) => ({
                    title: suggestion.title,
                    description: suggestion.description,
                    isSelected: false,
                  })
                );
                setSuggestions(suggestionItems);

                // Return result with timing metadata
                return {
                  suggestions: suggestionItems,
                  timing: {
                    estimatedDurationMs: response.estimatedDurationMs,
                    actualDurationMs: response.actualDurationMs,
                    isHistoricalEstimate: response.isHistoricalEstimate,
                  }
                };
              }
            }}
          />
        )}
        {activeTab === 'browse' && (() => {
          const [owner, repo] = selectedRepo.name.split('/');
          return <RepoBrowsePanel owner={owner} repo={repo} />;
        })()}
        {activeTab === 'todos' && (
          <RepoTodosPanel
            repositoryName={selectedRepo.alias || selectedRepo.name}
            repositoryId={selectedRepo.name}
          />
        )}
      </div>
    </div>
  );
};

export default RepoActionContainer;
