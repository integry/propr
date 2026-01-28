import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, RefreshCw, Loader2, CheckCircle, AlertCircle, Github } from 'lucide-react';
import { PlanIssue, STATUS_CONFIG, getPlanIssues, implementIssue, updatePlanIssue } from '../../api/planIssuesApi';
import { AgentConfig, getAgents } from '../../api/gitfixApi';
import { PlanTask } from '../../api/plannerApi';
import PlanIssueRow from './PlanIssueRow';
import AgentModelSelector from './AgentModelSelector';

interface PlanIssuesManagerProps {
  draftId: string;
  tasks: PlanTask[];
  repository?: string;
  onRefresh?: () => void;
  onViewPlanClick?: () => void;
}

const POLL_INTERVAL = 5000; // Polling interval for active issues

export const PlanIssuesManager: React.FC<PlanIssuesManagerProps> = ({
  draftId,
  tasks,
  repository,
  onRefresh,
  onViewPlanClick
}) => {
  const [issues, setIssues] = useState<PlanIssue[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [implementingIssue, setImplementingIssue] = useState<number | null>(null);
  const [showMerged, setShowMerged] = useState(false);

  const [globalAgent, setGlobalAgent] = useState<string | null>(null);
  const [globalModel, setGlobalModel] = useState<string | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  const issueTitles = React.useMemo(() => {
    const map: Record<number, string> = {};
    tasks.forEach(task => { if (task.issue_number) map[task.issue_number] = task.title; });
    return map;
  }, [tasks]);

  const { activeIssues, mergedIssues, pendingCount, hasActiveIssues } = useMemo(() => {
    const active: PlanIssue[] = [], merged: PlanIssue[] = [];
    let pending = 0, hasActive = false;
    issues.forEach(issue => {
      if (issue.status === 'merged') { merged.push(issue); }
      else {
        active.push(issue);
        if (issue.status === 'pending') pending++;
        if (STATUS_CONFIG[issue.status]?.isActive) hasActive = true;
      }
    });
    return { activeIssues: active, mergedIssues: merged, pendingCount: pending, hasActiveIssues: hasActive };
  }, [issues]);

  const fetchIssues = useCallback(async () => {
    try {
      const fetchedIssues = await getPlanIssues(draftId);
      setIssues(fetchedIssues);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch plan issues:', err);
      setError('Failed to load issues');
    }
  }, [draftId]);

  const fetchAgents = useCallback(async () => {
    try {
      const { agents: fetchedAgents } = await getAgents();
      setAgents(fetchedAgents);

      // Set default global agent/model from first enabled agent
      const enabledAgent = fetchedAgents.find(a => a.enabled);
      if (enabledAgent && !globalAgent) {
        setGlobalAgent(enabledAgent.alias);
        if (enabledAgent.defaultModel) {
          setGlobalModel(enabledAgent.defaultModel);
        } else if (enabledAgent.supportedModels?.length) {
          setGlobalModel(enabledAgent.supportedModels[0]);
        }
      }
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    }
  }, [globalAgent]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([fetchIssues(), fetchAgents()]);
      setLoading(false);
    };
    load();
  }, [fetchIssues, fetchAgents]);

  useEffect(() => {
    if (hasActiveIssues) {
      pollIntervalRef.current = window.setInterval(fetchIssues, POLL_INTERVAL);
    } else if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
  }, [hasActiveIssues, fetchIssues]);

  const handleImplementIssue = async (issueNumber: number) => {
    setImplementingIssue(issueNumber);
    try {
      await implementIssue(draftId, issueNumber);
      await fetchIssues();
      onRefresh?.();
    } catch (err) {
      console.error('Failed to implement issue:', err);
      setError('Failed to start implementation');
    } finally {
      setImplementingIssue(null);
    }
  };

  const [applyingGlobal, setApplyingGlobal] = useState(false);

  const handleGlobalAgentChange = (agentAlias: string | null) => {
    setGlobalAgent(agentAlias);

    // Get default model for the agent
    if (agentAlias) {
      const agent = agents.find(a => a.alias === agentAlias);
      if (agent?.defaultModel) {
        setGlobalModel(agent.defaultModel);
      } else if (agent?.supportedModels?.length) {
        setGlobalModel(agent.supportedModels[0]);
      }
    } else {
      setGlobalModel(null);
    }
  };

  const handleGlobalModelChange = (modelName: string | null) => setGlobalModel(modelName);

  const handleApplyToAll = async () => {
    if (!globalAgent) return;

    setApplyingGlobal(true);
    const pendingIssues = issues.filter(issue => issue.status === 'pending');

    try {
      await Promise.all(
        pendingIssues.map(issue =>
          updatePlanIssue(draftId, issue.issue_number, {
            agent_alias: globalAgent,
            model_name: globalModel
          })
        )
      );

      // Update local state
      setIssues(prev =>
        prev.map(issue =>
          issue.status === 'pending'
            ? { ...issue, agent_alias: globalAgent, model_name: globalModel }
            : issue
        )
      );
    } catch (err) {
      console.error('Failed to apply agent/model to all issues:', err);
      setError('Failed to apply agent/model to all issues');
    } finally {
      setApplyingGlobal(false);
    }
  };

  const handleAgentChange = async (issueNumber: number, agentAlias: string | null) => {
    try {
      let modelName: string | null = null;
      if (agentAlias) {
        const agent = agents.find(a => a.alias === agentAlias);
        if (agent?.defaultModel) {
          modelName = agent.defaultModel;
        } else if (agent?.supportedModels?.length) {
          modelName = agent.supportedModels[0];
        }
      }

      await updatePlanIssue(draftId, issueNumber, { agent_alias: agentAlias, model_name: modelName });
      setIssues(prev => prev.map(issue =>
        issue.issue_number === issueNumber ? { ...issue, agent_alias: agentAlias, model_name: modelName } : issue
      ));
    } catch (err) {
      console.error('Failed to update agent:', err);
      setError('Failed to update agent');
    }
  };

  const handleModelChange = async (issueNumber: number, modelName: string | null) => {
    try {
      await updatePlanIssue(draftId, issueNumber, { model_name: modelName });
      setIssues(prev => prev.map(issue =>
        issue.issue_number === issueNumber ? { ...issue, model_name: modelName } : issue
      ));
    } catch (err) {
      console.error('Failed to update model:', err);
      setError('Failed to update model');
    }
  };

  const handleRefresh = async () => {
    await fetchIssues();
    onRefresh?.();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-500">
        <Loader2 className="animate-spin mr-2" size={20} />
        <span>Loading issues...</span>
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <AlertCircle className="mx-auto mb-2 text-gray-400" size={24} />
        <p>No issues found for this plan.</p>
        {onViewPlanClick && (
          <button
            onClick={onViewPlanClick}
            className="inline-flex items-center gap-1.5 mt-4 px-3 py-1.5 text-sm font-medium rounded-md bg-white text-gray-900 shadow-sm border border-gray-200 hover:bg-gray-50 transition-colors"
          >
            <CheckCircle size={14} />
            View Plan
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
            Plan Issues
          </h3>
          <span className="text-xs text-gray-500">
            {issues.length} total
            {pendingCount > 0 && ` (${pendingCount} pending)`}
          </span>
          {repository && (
            <a
              href={`https://github.com/${repository}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-full hover:bg-gray-200 transition-colors"
            >
              <Github size={12} />
              {repository}
            </a>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
            title="Refresh issues"
          >
            <RefreshCw size={16} />
          </button>
          {hasActiveIssues && (
            <span className="flex items-center gap-1 text-xs text-blue-600">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              Auto-refreshing
            </span>
          )}
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
          <AlertCircle size={16} />
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-500 hover:text-red-700"
          >
            Dismiss
          </button>
        </div>
      )}
      {pendingCount > 0 && (
        <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
          <span className="text-sm font-medium text-gray-700">
            Set agent/model for all issues:
          </span>
          <AgentModelSelector
            agents={agents}
            selectedAgent={globalAgent}
            selectedModel={globalModel}
            onAgentChange={handleGlobalAgentChange}
            onModelChange={handleGlobalModelChange}
            disabled={applyingGlobal}
            compact
          />
          <button
            onClick={handleApplyToAll}
            disabled={!globalAgent || applyingGlobal}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {applyingGlobal ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Applying...
              </>
            ) : (
              <>
                <CheckCircle size={14} />
                Apply to All
              </>
            )}
          </button>
        </div>
      )}
      <div className="space-y-2">
        {activeIssues.map(issue => (
          <PlanIssueRow
            key={issue.id}
            issue={issue}
            issueTitle={issueTitles[issue.issue_number]}
            agents={agents}
            onImplement={handleImplementIssue}
            onAgentChange={handleAgentChange}
            onModelChange={handleModelChange}
            implementing={implementingIssue === issue.issue_number}
          />
        ))}
      </div>
      {mergedIssues.length > 0 && (
        <div className="border-t border-gray-200 pt-4 mt-4">
          <button
            onClick={() => setShowMerged(!showMerged)}
            className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
          >
            <CheckCircle size={16} className="text-green-600" />
            <span>Merged Issues ({mergedIssues.length})</span>
            {showMerged ? (
              <ChevronUp size={16} />
            ) : (
              <ChevronDown size={16} />
            )}
          </button>

          <AnimatePresence>
            {showMerged && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="mt-3 space-y-2"
              >
                {mergedIssues.map(issue => (
                  <PlanIssueRow
                    key={issue.id}
                    issue={issue}
                    issueTitle={issueTitles[issue.issue_number]}
                    agents={agents}
                    onImplement={handleImplementIssue}
                    onAgentChange={handleAgentChange}
                    onModelChange={handleModelChange}
                    implementing={false}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
};

export default PlanIssuesManager;
