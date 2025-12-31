import React, { useState, useEffect } from 'react';
import {
  getAgents,
  saveAgents,
  AgentConfig
} from '../api/gitfixApi';
import AgentsListSection from './SettingsPage/AgentsListSection';
import ChatPanel from '../components/AgentChat/ChatPanel';

const AiAgentsPage: React.FC = () => {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState<boolean>(true);
  const [agentsSaving, setAgentsSaving] = useState<boolean>(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsSuccess, setAgentsSuccess] = useState<string | null>(null);

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
        <div className="lg:w-[480px] lg:flex-shrink-0 overflow-y-auto">
          <AgentsListSection
            agents={agents}
            loading={agentsLoading}
            saving={agentsSaving}
            error={agentsError}
            success={agentsSuccess}
            onSaveAgents={handleSaveAgents}
          />
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
