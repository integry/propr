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
    <div className="max-w-[1600px] mx-auto p-6">
      <h2 className="text-gray-900 text-2xl font-semibold mb-8">AI Agents</h2>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Configuration */}
        <div className="lg:col-span-1">
          <AgentsListSection
            agents={agents}
            loading={agentsLoading}
            saving={agentsSaving}
            error={agentsError}
            success={agentsSuccess}
            onSaveAgents={handleSaveAgents}
          />
        </div>

        {/* Right Column: Chatbot */}
        <div className="lg:col-span-2">
          {!agentsLoading && <ChatPanel agents={agents} />}
        </div>
      </div>
    </div>
  );
};

export default AiAgentsPage;
