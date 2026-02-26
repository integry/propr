import React, { useState, useEffect, useCallback } from 'react';
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

  // Callback for Add Agent button in the header
  const [showAddModal, setShowAddModal] = useState(false);
  const handleAddAgentClick = useCallback(() => {
    setShowAddModal(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setShowAddModal(false);
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Continuous Horizon Header - single toolbar across both columns */}
      <div className="flex-shrink-0 border-b border-slate-200 bg-white">
        <PanelGroup direction="horizontal">
          {/* Left Header */}
          <Panel defaultSize={40} minSize={25}>
            <div className="h-14 px-6 flex items-center justify-between">
              <h2 className="text-gray-900 text-lg font-semibold">Agent Configuration</h2>
              <button
                onClick={handleAddAgentClick}
                disabled={agentsLoading || agentsSaving}
                className={`px-3 py-1.5 text-sm font-medium rounded-md border transition-colors ${
                  agentsLoading || agentsSaving
                    ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50 hover:border-gray-400'
                }`}
              >
                + Add Agent
              </button>
            </div>
          </Panel>

          {/* Header spacer for resize handle */}
          <div className="w-2" />

          {/* Right Header */}
          <Panel defaultSize={60} minSize={30}>
            <div className="h-14 px-6 flex items-center">
              <h2 className="text-gray-900 text-lg font-semibold">Assistant</h2>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      {/* Split-Pane Container - Resizable 40/60 layout */}
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* Left Panel (40%): Agent Configuration - clean white canvas */}
          <Panel defaultSize={40} minSize={25}>
            <div className="h-full bg-white flex flex-col overflow-y-auto">
              <div className="px-6 py-4">
                <AgentsListSection
                  agents={agents}
                  loading={agentsLoading}
                  saving={agentsSaving}
                  error={agentsError}
                  success={agentsSuccess}
                  onSaveAgents={handleSaveAgents}
                  showAddModal={showAddModal}
                  onCloseAddModal={handleCloseModal}
                />
              </div>
            </div>
          </Panel>

          {/* Resize Handle */}
          <PanelResizeHandle className="w-2 bg-slate-100 hover:bg-teal-500 transition-colors flex items-center justify-center cursor-col-resize">
            <GripVertical size={12} className="text-gray-400" />
          </PanelResizeHandle>

          {/* Right Panel (60%): Test Playground - semantic tinting */}
          <Panel defaultSize={60} minSize={30}>
            <div className="h-full bg-[#F8FAFC] flex flex-col">
              <div className="flex-1 min-h-0">
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
