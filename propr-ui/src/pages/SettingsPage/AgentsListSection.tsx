import React, { useState } from 'react';
import { AgentConfig } from '../../api/proprApi';
import Alert from './Alert';
import AgentConfigModal from './AgentConfigModal';
import AgentCard from './AgentCard';
import AgentLoginModal from './AgentLoginModal';

// --- Icons ---

const RobotIcon: React.FC<{ className?: string }> = ({ className = "w-12 h-12" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
);

const PlusIcon: React.FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
  </svg>
);

// --- Components ---

interface AgentsListSectionProps {
  agents: AgentConfig[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  warning: string | null;
  onSaveAgents: (agents: AgentConfig[]) => Promise<AgentConfig[] | undefined>;
  showAddModal?: boolean;
  onCloseAddModal?: () => void;
  onAddClick?: () => void;
  onSelectModel?: (agentId: string, modelId: string) => void;
  readOnly?: boolean;
}

const AgentsListSection: React.FC<AgentsListSectionProps> = ({
  agents,
  loading,
  saving,
  error,
  success,
  warning,
  onSaveAgents,
  showAddModal = false,
  onCloseAddModal,
  onAddClick,
  onSelectModel,
  readOnly = false
}) => {
  const [showModal, setShowModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null);
  const [loginAgent, setLoginAgent] = useState<AgentConfig | null>(null);

  // Handle external trigger for add modal from header button
  React.useEffect(() => {
    if (showAddModal && !readOnly) {
      setEditingAgent(null);
      setShowModal(true);
    }
  }, [readOnly, showAddModal]);

  const handleEditAgent = (agent: AgentConfig) => {
    setEditingAgent(agent);
    setShowModal(true);
  };

  const handleDeleteAgent = (agent: AgentConfig) => {
    if (confirm(`Are you sure you want to delete the agent "${agent.alias}"?`)) {
      const updatedAgents = agents.filter(a => a.id !== agent.id);
      onSaveAgents(updatedAgents);
    }
  };

  const handleToggleAgent = (agent: AgentConfig) => {
    const updatedAgents = agents.map(a =>
      a.id === agent.id ? { ...a, enabled: !a.enabled } : a
    );
    onSaveAgents(updatedAgents);
  };

  const handleSaveAgent = async (
    agent: AgentConfig,
    options?: { loginAfterSave: boolean },
  ) => {
    let updatedAgents: AgentConfig[];
    const existingIndex = agents.findIndex(a => a.id === agent.id);

    if (existingIndex >= 0) {
      // Update existing agent
      updatedAgents = [...agents];
      updatedAgents[existingIndex] = agent;
    } else {
      // Add new agent
      updatedAgents = [...agents, agent];
    }

    const savedAgents = await onSaveAgents(updatedAgents);
    if (!savedAgents) return;
    setShowModal(false);
    setEditingAgent(null);
    onCloseAddModal?.();
    if (options?.loginAfterSave) {
      setLoginAgent(savedAgents.find(saved => saved.id === agent.id) ?? agent);
    }
  };

  const existingAliases = agents
    .filter(a => !editingAgent || a.id !== editingAgent.id)
    .map(a => a.alias);

  return (
    <div>
      {readOnly && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Demo mode is read-only. Agent configuration can be inspected but not changed.
        </div>
      )}
      {error && <Alert message={error} type="error" />}
      {warning && <Alert message={warning} type="warning" />}
      {success && <Alert message={success} type="success" />}

      {loading ? (
        <p className="text-gray-600">Loading agents...</p>
      ) : (
        <div>
          {agents.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onLogin={() => setLoginAgent(agent)}
              onEdit={() => handleEditAgent(agent)}
              onDelete={() => handleDeleteAgent(agent)}
              onToggle={() => handleToggleAgent(agent)}
              onSelectModel={onSelectModel}
              readOnly={readOnly}
            />
          ))}
          {agents.length === 0 && (
            <div className="text-center py-12 px-4">
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center">
                  <RobotIcon className="w-8 h-8 text-gray-400" />
                </div>
              </div>
              <h3 className="text-gray-900 font-medium text-base mb-2">No agents configured</h3>
              <p className="text-gray-500 text-sm mb-6 max-w-sm mx-auto">
                Configure AI agents to connect to providers like OpenAI, Anthropic, or other LLM services.
              </p>
              <button
                onClick={onAddClick}
                disabled={readOnly}
                className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${readOnly ? 'cursor-not-allowed bg-gray-300' : 'bg-primary-600 hover:bg-primary-700'}`}
              >
                <PlusIcon className="w-4 h-4" />
                Add First Agent
              </button>
            </div>
          )}
        </div>
      )}

      {saving && (
        <p className="text-gray-600 mt-4">Saving agents...</p>
      )}

      {showModal && (
        <AgentConfigModal
          agent={editingAgent}
          existingAliases={existingAliases}
          onClose={() => {
            setShowModal(false);
            setEditingAgent(null);
            onCloseAddModal?.();
          }}
          onSave={handleSaveAgent}
          saving={saving}
        />
      )}

      {loginAgent && (
        <AgentLoginModal
          key={loginAgent.id}
          agent={loginAgent}
          onClose={() => setLoginAgent(null)}
        />
      )}
    </div>
  );
};

export default AgentsListSection;
