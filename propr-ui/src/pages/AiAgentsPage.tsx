import React, { useState, useEffect, useCallback } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { GripVertical, MessageSquare, Settings } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  getAgents,
  saveAgents,
  AgentConfig
} from '../api/proprApi';
import AgentsListSection from './SettingsPage/AgentsListSection';
import ChatPanel from '../components/AgentChat/ChatPanel';
import { useDemoMode } from '../contexts/DemoModeContext';

const AiAgentsPage: React.FC = () => {
  useDocumentTitle('AI Agents');
  const { isDemoMode } = useDemoMode();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState<boolean>(true);
  const [agentsSaving, setAgentsSaving] = useState<boolean>(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsSuccess, setAgentsSuccess] = useState<string | null>(null);

  // Mobile tab state: 'config' or 'playground'
  const [mobileTab, setMobileTab] = useState<'config' | 'playground'>('playground');

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
    if (isDemoMode) {
      setAgentsError('Demo mode is read-only. Agent settings cannot be saved.');
      return;
    }
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
    if (isDemoMode) return;
    setShowAddModal(true);
  }, [isDemoMode]);

  const handleCloseModal = useCallback(() => {
    setShowAddModal(false);
  }, []);

  // Mobile layout
  const renderMobileLayout = () => (
    <div className="h-full flex flex-col overflow-hidden sm:hidden">
      {/* Mobile Header with Tabs */}
      <div className="flex-shrink-0 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between px-4 py-2">
          <h1 className="text-lg font-bold text-gray-800">AI Agents</h1>
          {mobileTab === 'config' && (
            <button
              onClick={handleAddAgentClick}
              disabled={agentsLoading || agentsSaving || isDemoMode}
              className={`px-2 py-1 text-xs font-medium rounded-md border transition-colors ${
                agentsLoading || agentsSaving || isDemoMode
                  ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              + Add
            </button>
          )}
        </div>
        {/* Tab Bar */}
        <div className="flex border-t border-slate-100">
          <button
            onClick={() => setMobileTab('playground')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
              mobileTab === 'playground'
                ? 'text-teal-600 border-b-2 border-teal-600 bg-teal-50'
                : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
            }`}
          >
            <MessageSquare size={16} />
            Playground
          </button>
          <button
            onClick={() => setMobileTab('config')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
              mobileTab === 'config'
                ? 'text-teal-600 border-b-2 border-teal-600 bg-teal-50'
                : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
            }`}
          >
            <Settings size={16} />
            Configuration
          </button>
        </div>
      </div>

      {/* Mobile Content */}
      <div className="flex-1 overflow-auto">
        {mobileTab === 'playground' ? (
          <div className="h-full bg-[#F8FAFC] flex flex-col">
            <div className="flex-1 min-h-0">
              {!agentsLoading && <ChatPanel agents={agents} disabled={isDemoMode} />}
            </div>
          </div>
        ) : (
          <div className="h-full bg-white">
            <div className="px-4 py-4">
              <AgentsListSection
                agents={agents}
                loading={agentsLoading}
                saving={agentsSaving}
                error={agentsError}
                success={agentsSuccess}
                onSaveAgents={handleSaveAgents}
                showAddModal={showAddModal}
                onCloseAddModal={handleCloseModal}
                onAddClick={handleAddAgentClick}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // Desktop layout (existing split-pane)
  const renderDesktopLayout = () => (
    <div className="h-full hidden sm:flex flex-col overflow-hidden">
      {/* Continuous Horizon Header - single toolbar across both columns */}
      <div className="flex-shrink-0 border-b border-slate-200 bg-white">
        <PanelGroup direction="horizontal">
          {/* Left Header */}
          <Panel defaultSize={40} minSize={25}>
            <div className="h-14 px-6 flex items-center justify-between">
              <h2 className="text-gray-900 text-lg font-semibold">Agent Configuration</h2>
              <button
                onClick={handleAddAgentClick}
                disabled={agentsLoading || agentsSaving || isDemoMode}
                className={`px-3 py-1.5 text-sm font-medium rounded-md border transition-colors ${
                  agentsLoading || agentsSaving || isDemoMode
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
              <h2 className="text-gray-900 text-lg font-semibold">Playground</h2>
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
                  onAddClick={handleAddAgentClick}
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
                {!agentsLoading && <ChatPanel agents={agents} disabled={isDemoMode} />}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );

  return (
    <>
      {renderMobileLayout()}
      {renderDesktopLayout()}
    </>
  );
};

export default AiAgentsPage;
