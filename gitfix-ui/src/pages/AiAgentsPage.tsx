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
    <div className="h-full flex flex-col overflow-hidden">
      {/* Split-Pane Container - 40/60 layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left Pane (40%): Agent Configuration */}
        <div className={`bg-white flex flex-col transition-all duration-300 ${
          isAgentColumnCollapsed ? 'w-0 overflow-hidden' : 'w-2/5'
        }`}>
          {!isAgentColumnCollapsed && (
            <>
              <div className="p-6 pb-0 flex-shrink-0">
                <h2 className="text-gray-900 text-2xl font-semibold mb-6">Agent Configuration</h2>
              </div>
              <div className="flex-1 overflow-y-auto px-6 pb-6">
                <AgentsListSection
                  agents={agents}
                  loading={agentsLoading}
                  saving={agentsSaving}
                  error={agentsError}
                  success={agentsSuccess}
                  onSaveAgents={handleSaveAgents}
                />
              </div>
            </>
          )}
        </div>

        {/* Collapse/Expand Button - positioned between panes */}
        <div className="flex-shrink-0 flex items-center bg-gray-100 border-l border-r border-gray-200">
          <button
            onClick={() => setIsAgentColumnCollapsed(!isAgentColumnCollapsed)}
            className="p-1.5 hover:bg-gray-200 transition-colors"
            title={isAgentColumnCollapsed ? 'Show agent configuration' : 'Hide agent configuration'}
          >
            <svg
              className={`w-4 h-4 text-gray-500 transition-transform duration-300 ${isAgentColumnCollapsed ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>

        {/* Right Pane (60%): Test Playground */}
        <div className={`bg-slate-50 flex flex-col transition-all duration-300 ${
          isAgentColumnCollapsed ? 'flex-1' : 'w-3/5'
        }`}>
          <div className="p-6 pb-0 flex-shrink-0">
            <h2 className="text-gray-900 text-2xl font-semibold mb-6">Test Playground</h2>
          </div>
          <div className="flex-1 min-h-0 px-6 pb-6">
            {!agentsLoading && <ChatPanel agents={agents} />}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AiAgentsPage;
