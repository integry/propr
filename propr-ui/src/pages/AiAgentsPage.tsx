import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { GripVertical, MessageSquare, Settings } from 'lucide-react';
import type { SyntheticAgentConfig } from '@propr/shared';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  getAgents,
  saveAgents,
  getSyntheticAgents,
  saveSyntheticAgents,
  AgentConfig
} from '../api/proprApi';
import AgentsListSection from './SettingsPage/AgentsListSection';
import ChatPanel, { type AgentModelSelection } from '../components/AgentChat/ChatPanel';
import { useDemoMode } from '../contexts/DemoModeContext';
import { isCommittedConfigWriteError } from '../api/apiClient';
import SyntheticPoolsSection from './SyntheticPoolsSection';

const AiAgentsPage: React.FC = () => {
  useDocumentTitle('AI Agents');
  const { isDemoMode } = useDemoMode();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState<boolean>(true);
  const [agentsSaving, setAgentsSaving] = useState<boolean>(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsSuccess, setAgentsSuccess] = useState<string | null>(null);
  const [agentsWarning, setAgentsWarning] = useState<string | null>(null);
  const agentsReloadRequiredRef = useRef(false);
  const [syntheticAgents, setSyntheticAgents] = useState<SyntheticAgentConfig[]>([]);
  const [syntheticLoading, setSyntheticLoading] = useState(true);
  const [syntheticSaving, setSyntheticSaving] = useState(false);
  const [syntheticError, setSyntheticError] = useState<string | null>(null);
  const [syntheticWarning, setSyntheticWarning] = useState<string | null>(null);
  const [syntheticSuccess, setSyntheticSuccess] = useState<string | null>(null);
  const [configView, setConfigView] = useState<'direct' | 'synthetic'>('direct');
  const [addPoolRequest, setAddPoolRequest] = useState(0);

  // Mobile tab state: 'config' or 'playground'
  const [mobileTab, setMobileTab] = useState<'config' | 'playground'>('playground');
  const [selectedModels, setSelectedModels] = useState<AgentModelSelection[]>([]);

  useEffect(() => {
    const loadAgents = async () => {
      try {
        setAgentsLoading(true);
        setAgentsError(null);
        const data = await getAgents();
        setAgents(data.agents || []);
        agentsReloadRequiredRef.current = false;
      } catch (err) {
        setAgentsError((err as Error).message || 'Failed to load agents');
      } finally {
        setAgentsLoading(false);
      }
    };
    loadAgents();
  }, []);

  useEffect(() => {
    const loadPools = async () => {
      try {
        setSyntheticLoading(true);
        setSyntheticError(null);
        // Keeps the page compatible with older servers and isolated UI mocks.
        if (typeof getSyntheticAgents !== 'function') return;
        const data = await getSyntheticAgents();
        setSyntheticAgents(data.synthetic_agents ?? []);
      } catch (err) {
        setSyntheticError((err as Error).message || 'Failed to load synthetic pools');
      } finally {
        setSyntheticLoading(false);
      }
    };
    void loadPools();
  }, []);

  const handleSaveSyntheticAgents = async (updated: SyntheticAgentConfig[]): Promise<SyntheticAgentConfig[] | undefined> => {
    if (isDemoMode) {
      setSyntheticError('Demo mode is read-only. Synthetic pools cannot be saved.');
      return undefined;
    }
    try {
      setSyntheticSaving(true);
      setSyntheticError(null);
      setSyntheticWarning(null);
      setSyntheticSuccess(null);
      const result = await saveSyntheticAgents(updated);
      const saved = result.synthetic_agents ?? updated;
      setSyntheticAgents(saved);
      setSyntheticWarning(result.warnings?.join(' ') || null);
      setSyntheticSuccess('Synthetic pools updated successfully.');
      return saved;
    } catch (err) {
      // Do not replace local configuration here: the editor intentionally stays
      // open with its unsaved draft when backend validation fails.
      setSyntheticError((err as Error).message || 'Failed to update synthetic pools');
      return undefined;
    } finally {
      setSyntheticSaving(false);
    }
  };

  const handleSaveAgents = async (updatedAgents: AgentConfig[]): Promise<AgentConfig[] | undefined> => {
    if (isDemoMode) {
      setAgentsError('Demo mode is read-only. Agent settings cannot be saved.');
      return undefined;
    }
    if (agentsReloadRequiredRef.current) {
      setAgentsError('Reload the current agent configuration before saving again.');
      return undefined;
    }
    try {
      setAgentsSaving(true);
      setAgentsError(null);
      setAgentsSuccess(null);
      setAgentsWarning(null);
      const result = await saveAgents(updatedAgents);
      setAgents(result.agents || updatedAgents);
      setAgentsWarning(result.warnings?.join(' ') || null);
      setAgentsSuccess('Agents updated successfully! Changes are applied immediately.');
      return result.agents || updatedAgents;
    } catch (err) {
      if (isCommittedConfigWriteError(err)) {
        try {
          const current = await getAgents();
          setAgents(current.agents || []);
          agentsReloadRequiredRef.current = false;
        } catch (refreshError) {
          agentsReloadRequiredRef.current = true;
          const refreshMessage = refreshError instanceof Error ? refreshError.message : String(refreshError);
          setAgentsError(`${err.message} Automatic refresh failed (${refreshMessage}). Reload this page before editing agents again.`);
          return undefined;
        }
      }
      setAgentsError((err as Error).message || 'Failed to update agents');
      return undefined;
    } finally {
      setAgentsSaving(false);
    }
  };

  // Callback for Add Agent button in the header
  const [showAddModal, setShowAddModal] = useState(false);
  const handleAddAgentClick = useCallback(() => {
    if (isDemoMode) {
      setAgentsError('Demo mode is read-only. Agent configuration cannot be changed.');
      return;
    }
    setShowAddModal(true);
  }, [isDemoMode]);

  const handleAddClick = useCallback(() => {
    if (configView === 'synthetic') {
      if (isDemoMode) {
        setSyntheticError('Demo mode is read-only. Synthetic pool configuration cannot be changed.');
        return;
      }
      setAddPoolRequest(value => value + 1);
      return;
    }
    handleAddAgentClick();
  }, [configView, handleAddAgentClick, isDemoMode]);

  const handleCloseModal = useCallback(() => {
    setShowAddModal(false);
  }, []);

  const handleSelectModel = useCallback((agentId: string, modelId: string) => {
    const agent = agents.find(candidate => candidate.id === agentId);
    if (!agent?.enabled || !agent.supportedModels.includes(modelId)) return;

    setSelectedModels([{ agentId, modelId }]);
    setMobileTab('playground');
  }, [agents]);

  // Mobile layout
  const renderMobileLayout = () => (
    <div className="h-full flex flex-col overflow-hidden sm:hidden">
      {/* Mobile Header with Tabs */}
      <div className="flex-shrink-0 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between px-4 py-2">
          <h1 className="text-lg font-bold text-gray-800">AI Agents</h1>
          {mobileTab === 'config' && (
            <button
              onClick={handleAddClick}
              disabled={agentsLoading || agentsSaving || syntheticLoading || syntheticSaving || isDemoMode}
              className={`px-2 py-1 text-xs font-medium rounded-md border transition-colors ${
                agentsLoading || agentsSaving || syntheticLoading || syntheticSaving || isDemoMode
                  ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {configView === 'synthetic' ? '+ Pool' : '+ Add'}
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
              {!agentsLoading && (
                <ChatPanel
                  agents={agents}
                  syntheticAgents={syntheticAgents}
                  selectedModels={selectedModels}
                  onSelectedModelsChange={setSelectedModels}
                  disabled={isDemoMode}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="h-full bg-white">
            <div className="px-4 py-4">
              <div className="mb-4 flex rounded-md bg-slate-100 p-1 text-xs font-medium">
                <button type="button" onClick={() => setConfigView('direct')} className={`flex-1 rounded px-2 py-1.5 ${configView === 'direct' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Direct agents</button>
                <button type="button" onClick={() => setConfigView('synthetic')} className={`flex-1 rounded px-2 py-1.5 ${configView === 'synthetic' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Synthetic Pools</button>
              </div>
              {configView === 'direct' ? <AgentsListSection
                agents={agents}
                loading={agentsLoading}
                saving={agentsSaving}
                error={agentsError}
                success={agentsSuccess}
                warning={agentsWarning}
                onSaveAgents={handleSaveAgents}
                showAddModal={showAddModal}
                onCloseAddModal={handleCloseModal}
                onAddClick={handleAddAgentClick}
                onSelectModel={handleSelectModel}
                readOnly={isDemoMode}
              /> : <SyntheticPoolsSection
                agents={agents}
                pools={syntheticAgents}
                loading={syntheticLoading}
                saving={syntheticSaving}
                error={syntheticError}
                success={syntheticSuccess}
                warning={syntheticWarning}
                readOnly={isDemoMode}
                addRequested={addPoolRequest}
                onSave={handleSaveSyntheticAgents}
              />}
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
              <div>
                <h2 className="text-gray-900 text-lg font-semibold">Agent Configuration</h2>
              </div>
              <button
                onClick={handleAddClick}
                disabled={agentsLoading || agentsSaving || syntheticLoading || syntheticSaving || isDemoMode}
                className={`px-3 py-1.5 text-sm font-medium rounded-md border transition-colors ${
                  agentsLoading || agentsSaving || syntheticLoading || syntheticSaving || isDemoMode
                    ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50 hover:border-gray-400'
                }`}
              >
                {configView === 'synthetic' ? '+ Add Pool' : '+ Add Agent'}
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
                <div className="mb-4 flex rounded-md bg-slate-100 p-1 text-xs font-medium">
                  <button type="button" onClick={() => setConfigView('direct')} className={`flex-1 rounded px-2 py-1.5 ${configView === 'direct' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Direct agents</button>
                  <button type="button" onClick={() => setConfigView('synthetic')} className={`flex-1 rounded px-2 py-1.5 ${configView === 'synthetic' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Synthetic Pools</button>
                </div>
                {configView === 'direct' ? <AgentsListSection
                  agents={agents}
                  loading={agentsLoading}
                  saving={agentsSaving}
                  error={agentsError}
                  success={agentsSuccess}
                  warning={agentsWarning}
                  onSaveAgents={handleSaveAgents}
                  showAddModal={showAddModal}
                  onCloseAddModal={handleCloseModal}
                  onAddClick={handleAddAgentClick}
                  onSelectModel={handleSelectModel}
                  readOnly={isDemoMode}
                /> : <SyntheticPoolsSection
                  agents={agents}
                  pools={syntheticAgents}
                  loading={syntheticLoading}
                  saving={syntheticSaving}
                  error={syntheticError}
                  success={syntheticSuccess}
                  warning={syntheticWarning}
                  readOnly={isDemoMode}
                  addRequested={addPoolRequest}
                  onSave={handleSaveSyntheticAgents}
                />}
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
                {!agentsLoading && (
                  <ChatPanel
                    agents={agents}
                    syntheticAgents={syntheticAgents}
                    selectedModels={selectedModels}
                    onSelectedModelsChange={setSelectedModels}
                    disabled={isDemoMode}
                  />
                )}
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
