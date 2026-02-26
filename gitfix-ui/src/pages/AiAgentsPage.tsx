import React, { useState, useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { GripVertical } from 'lucide-react';
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
      {/* Split-Pane Container - Resizable 40/60 layout */}
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* Left Panel (40%): Agent Configuration */}
          <Panel defaultSize={40} minSize={25}>
            <div className="h-full bg-white flex flex-col">
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
            </div>
          </Panel>

          {/* Resize Handle */}
          <PanelResizeHandle className="w-2 bg-gray-200 hover:bg-teal-500 transition-colors flex items-center justify-center cursor-col-resize">
            <GripVertical size={12} className="text-gray-400" />
          </PanelResizeHandle>

          {/* Right Panel (60%): Test Playground */}
          <Panel defaultSize={60} minSize={30}>
            <div className="h-full bg-slate-50 flex flex-col">
              <div className="p-6 pb-0 flex-shrink-0">
                <h2 className="text-gray-900 text-2xl font-semibold mb-6">Test Playground</h2>
              </div>
              <div className="flex-1 min-h-0 px-6 pb-6">
                {!agentsLoading && <ChatPanel agents={agents} />}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
};

export default AiAgentsPage;
