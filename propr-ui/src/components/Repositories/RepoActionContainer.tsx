import React, { useState, useCallback } from 'react';
import { MessageSquareText, Sparkles } from 'lucide-react';
import RepoChatPanel from './RepoChatPanel';
import { chatWithRepository, ChatMessage } from '../../api/repoChatApi';

type ActionTab = 'chat' | 'improve';

interface TabButtonProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ label, icon, isActive, onClick }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-3 py-2 text-[11px] font-bold uppercase tracking-widest transition-all border-b-2 -mb-px
      ${isActive
        ? 'text-teal-600 border-teal-500'
        : 'text-slate-400 border-transparent hover:text-slate-600 hover:border-slate-300'
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
}

const RepoActionContainer: React.FC<RepoActionContainerProps> = ({ selectedRepo }) => {
  const [activeTab, setActiveTab] = useState<ActionTab>('chat');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

  const handleSendMessage = useCallback(async (message: string): Promise<string> => {
    if (!selectedRepo) {
      throw new Error('No repository selected');
    }

    const branch = selectedRepo.baseBranch || 'HEAD';

    // Add user message to history for context
    const updatedHistory: ChatMessage[] = [
      ...chatHistory,
      { role: 'user' as const, content: message }
    ];

    try {
      const response = await chatWithRepository(
        selectedRepo.name,
        branch,
        message,
        chatHistory
      );

      if (response.error) {
        throw new Error(response.error);
      }

      // Update history with both user message and assistant response
      setChatHistory([
        ...updatedHistory,
        { role: 'assistant' as const, content: response.reply }
      ]);

      return response.reply;
    } catch (error) {
      // Still update history with user message even on error
      setChatHistory(updatedHistory);
      throw error;
    }
  }, [selectedRepo, chatHistory]);

  // Reset chat history when selected repo changes
  React.useEffect(() => {
    setChatHistory([]);
  }, [selectedRepo?.id]);

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
    <div className="h-full flex flex-col">
      {/* Tab Header */}
      <div className="flex items-end px-4 border-b border-gray-100 bg-white">
        <div className="flex items-center">
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
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0">
        {activeTab === 'chat' && (
          <RepoChatPanel
            onSendMessage={handleSendMessage}
            repositoryName={selectedRepo.alias || selectedRepo.name}
          />
        )}
        {activeTab === 'improve' && (
          <div className="h-full flex items-center justify-center bg-slate-50">
            <div className="text-center p-8">
              <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center mb-3 mx-auto">
                <Sparkles size={24} className="text-gray-400" />
              </div>
              <h3 className="text-sm font-medium text-gray-700 mb-1">
                Improvements
              </h3>
              <p className="text-xs text-gray-500 max-w-xs">
                AI-powered code improvements and suggestions coming soon.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RepoActionContainer;
