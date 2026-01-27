import React, { useState, useEffect } from 'react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  getAgents,
  saveAgents,
  AgentConfig
} from '../api/gitfixApi';
import AgentsListSection from './SettingsPage/AgentsListSection';
import ChatPanel from '../components/AgentChat/ChatPanel';

const AiAgentsPage: React.FC = () => {
  useDocumentTitle('AI Agents');
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState<boolean>(true);
  const [agentsSaving, setAgentsSaving] = useState<boolean>(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsSuccess, setAgentsSuccess] = useState<string | null>(null);
  const [isAgentColumnCollapsed, setIsAgentColumnCollapsed] = useState<boolean>(false);

  useEffect(() => {
    const loadAgents = async () => {
      try {
        setAgentsLoading(true);
        setAgentsError(null);
        const data = await getAgents();
        setAgents(data.agents || []);
      } catch (err) {
        setAgentsError((err as Error).message || 'Failed to load agents');
      } finally {
        setAgentsLoading(false);
      }
    };
    loadAgents();
  }, []);

  const handleSaveAgents = async (updatedAgents: AgentConfig[]) => {
    try {
      setAgentsSaving(true);
      setAgentsError(null);
      setAgentsSuccess(null);
      await saveAgents(updatedAgents);
      setAgents(updatedAgents);
      setAgentsSuccess('Agents updated successfully! Changes are applied immediately.');
    } catch (err) {
      setAgentsError((err as Error).message || 'Failed to update agents');
    } finally {
      setAgentsSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col p-6">
      <h2 className="text-gray-900 text-2xl font-semibold mb-8">AI Agents</h2>

      <div className="flex-1 flex flex-col lg:flex-row gap-8 min-h-0">
        {/* Left Column: Configuration */}
        <div className={`lg:flex-shrink-0 overflow-y-auto transition-all duration-300 ${
          isAgentColumnCollapsed ? 'lg:w-0 lg:overflow-hidden' : 'lg:w-[800px] lg:min-w-[800px]'
        }`}>
          {!isAgentColumnCollapsed && (
            <AgentsListSection
              agents={agents}
              loading={agentsLoading}
              saving={agentsSaving}
              error={agentsError}
              success={agentsSuccess}
              onSaveAgents={handleSaveAgents}
            />
          )}
        </div>

        {/* Collapse/Expand Button */}
        <div className="hidden lg:flex items-start pt-2">
          <button
            onClick={() => setIsAgentColumnCollapsed(!isAgentColumnCollapsed)}
            className="p-2 bg-gray-100 hover:bg-gray-200 rounded-lg border border-gray-300 transition-colors"
            title={isAgentColumnCollapsed ? 'Show agent configuration' : 'Hide agent configuration'}
          >
            <svg
              className={`w-5 h-5 text-gray-600 transition-transform duration-300 ${isAgentColumnCollapsed ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>

        {/* Right Column: Chatbot - expands to fill remaining space */}
        <div className="flex-1 min-w-0 min-h-0">
          {!agentsLoading && <ChatPanel agents={agents} />}
        </div>
      </div>
    </div>
  );
};

export default AiAgentsPage;
