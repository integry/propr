import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { PlanIssue, STATUS_CONFIG, getPlanIssues, implementIssue, updatePlanIssue, AgentModelPair } from '../../api/planIssuesApi';
import { AgentConfig, getAgents } from '../../api/gitfixApi';
import { PlanTask } from '../../api/plannerApi';

const POLL_INTERVAL = 5000;

interface UsePlanIssuesManagerProps {
  draftId: string;
  tasks: PlanTask[];
  onRefresh?: () => void;
}

export function usePlanIssuesManager({ draftId, tasks, onRefresh }: UsePlanIssuesManagerProps) {
  const [issues, setIssues] = useState<PlanIssue[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [implementingIssue, setImplementingIssue] = useState<number | null>(null);

  const [globalAgent, setGlobalAgent] = useState<string | null>(null);
  const [globalModel, setGlobalModel] = useState<string | null>(null);
  const [globalIsMulti, setGlobalIsMulti] = useState(false);
  const [globalSelectedModels, setGlobalSelectedModels] = useState<AgentModelPair[]>([]);
  const [applyingGlobal, setApplyingGlobal] = useState(false);

  const pollIntervalRef = useRef<number | null>(null);

  const issueTitles = useMemo(() => {
    const map: Record<number, string> = {};
    tasks.forEach(task => { if (task.issue_number) map[task.issue_number] = task.title; });
    return map;
  }, [tasks]);

  const issuesWithDefaults = useMemo(() => {
    const defaultAgent = agents.find(a => a.enabled);
    if (!defaultAgent) return issues;

    const defaultAlias = defaultAgent.alias;
    const defaultModel = defaultAgent.defaultModel ?? defaultAgent.supportedModels?.[0] ?? null;

    return issues.map(issue => {
      if (issue.status === 'pending' && !issue.agent_alias) {
        return { ...issue, agent_alias: defaultAlias, model_name: defaultModel };
      }
      return issue;
    });
  }, [issues, agents]);

  const { activeIssues, mergedIssues, pendingCount, hasActiveIssues, firstPendingIssueNumber } = useMemo(() => {
    const active: PlanIssue[] = [], merged: PlanIssue[] = [];
    let pending = 0, hasActive = false;

    const sortedIssues = [...issuesWithDefaults].sort((a, b) => a.issue_number - b.issue_number);

    let firstUnmergedIssueNumber: number | null = null;
    for (const issue of sortedIssues) {
      if (issue.status !== 'merged') {
        firstUnmergedIssueNumber = issue.issue_number;
        break;
      }
    }

    let firstPending: number | null = null;

    issuesWithDefaults.forEach(issue => {
      if (issue.status === 'merged') { merged.push(issue); }
      else {
        active.push(issue);
        if (issue.status === 'pending') {
          pending++;
          if (issue.issue_number === firstUnmergedIssueNumber) {
            firstPending = issue.issue_number;
          }
        }
        if (STATUS_CONFIG[issue.status]?.isActive) hasActive = true;
      }
    });
    return { activeIssues: active, mergedIssues: merged, pendingCount: pending, hasActiveIssues: hasActive, firstPendingIssueNumber: firstPending };
  }, [issuesWithDefaults]);

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
      const enabledAgent = fetchedAgents.find(a => a.enabled);
      if (enabledAgent && !globalAgent) {
        setGlobalAgent(enabledAgent.alias);
        setGlobalModel(enabledAgent.defaultModel ?? enabledAgent.supportedModels?.[0] ?? null);
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

  const handleImplementIssue = useCallback(async (issueNumber: number, models?: AgentModelPair[]) => {
    setImplementingIssue(issueNumber);
    try {
      const options = models && models.length > 0 ? { models } : undefined;
      await implementIssue(draftId, issueNumber, options);
      await fetchIssues();
      onRefresh?.();
    } catch (err) {
      console.error('Failed to implement issue:', err);
      setError('Failed to start implementation');
    } finally {
      setImplementingIssue(null);
    }
  }, [draftId, fetchIssues, onRefresh]);

  const getDefaultModelForAgent = useCallback((agentAlias: string | null): string | null => {
    if (!agentAlias) return null;
    const agent = agents.find(a => a.alias === agentAlias);
    return agent?.defaultModel ?? agent?.supportedModels?.[0] ?? null;
  }, [agents]);

  const handleGlobalAgentChange = useCallback((agentAlias: string | null) => {
    setGlobalAgent(agentAlias);
    setGlobalModel(getDefaultModelForAgent(agentAlias));
  }, [getDefaultModelForAgent]);

  const handleGlobalModelChange = useCallback((modelName: string | null) => setGlobalModel(modelName), []);

  const handleGlobalMultiToggle = useCallback((isMulti: boolean) => {
    setGlobalIsMulti(isMulti);
    if (!isMulti) {
      setGlobalSelectedModels([]);
    }
  }, []);

  const handleGlobalMultiModelChange = useCallback((models: AgentModelPair[]) => {
    setGlobalSelectedModels(models);
  }, []);

  const handleApplyToAll = useCallback(async () => {
    // In multi mode, we need at least one selected model
    if (globalIsMulti && globalSelectedModels.length === 0) {
      return;
    }
    // In single mode, we need an agent
    if (!globalIsMulti && !globalAgent) {
      return;
    }

    setApplyingGlobal(true);
    const pendingIssues = issues.filter(issue => issue.status === 'pending');

    try {
      if (globalIsMulti) {
        // Multi-mode: apply first selected model to all issues (storing config for multi-agent)
        const primaryModel = globalSelectedModels[0];
        await Promise.all(
          pendingIssues.map(issue =>
            updatePlanIssue(draftId, issue.issue_number, {
              agent_alias: primaryModel.agent_alias,
              model_name: primaryModel.model_name
            })
          )
        );

        setIssues(prev =>
          prev.map(issue =>
            issue.status === 'pending'
              ? { ...issue, agent_alias: primaryModel.agent_alias, model_name: primaryModel.model_name }
              : issue
          )
        );
      } else {
        // Single-mode: apply the selected agent/model to all issues
        await Promise.all(
          pendingIssues.map(issue =>
            updatePlanIssue(draftId, issue.issue_number, {
              agent_alias: globalAgent,
              model_name: globalModel
            })
          )
        );

        setIssues(prev =>
          prev.map(issue =>
            issue.status === 'pending'
              ? { ...issue, agent_alias: globalAgent, model_name: globalModel }
              : issue
          )
        );
      }
    } catch (err) {
      console.error('Failed to apply agent/model to all issues:', err);
      setError('Failed to apply agent/model to all issues');
    } finally {
      setApplyingGlobal(false);
    }
  }, [globalIsMulti, globalAgent, globalModel, globalSelectedModels, issues, draftId]);

  const handleAgentChange = useCallback(async (issueNumber: number, agentAlias: string | null) => {
    try {
      const modelName = getDefaultModelForAgent(agentAlias);
      await updatePlanIssue(draftId, issueNumber, { agent_alias: agentAlias, model_name: modelName });
      setIssues(prev => prev.map(issue =>
        issue.issue_number === issueNumber ? { ...issue, agent_alias: agentAlias, model_name: modelName } : issue
      ));
    } catch (err) {
      console.error('Failed to update agent:', err);
      setError('Failed to update agent');
    }
  }, [draftId, getDefaultModelForAgent]);

  const handleModelChange = useCallback(async (issueNumber: number, modelName: string | null) => {
    try {
      await updatePlanIssue(draftId, issueNumber, { model_name: modelName });
      setIssues(prev => prev.map(issue =>
        issue.issue_number === issueNumber ? { ...issue, model_name: modelName } : issue
      ));
    } catch (err) {
      console.error('Failed to update model:', err);
      setError('Failed to update model');
    }
  }, [draftId]);

  const handleRefresh = useCallback(async () => { await fetchIssues(); onRefresh?.(); }, [fetchIssues, onRefresh]);

  const clearError = useCallback(() => setError(null), []);

  return {
    issues,
    agents,
    loading,
    error,
    clearError,
    implementingIssue,
    issueTitles,
    activeIssues,
    mergedIssues,
    pendingCount,
    hasActiveIssues,
    firstPendingIssueNumber,
    globalAgent,
    globalModel,
    globalIsMulti,
    globalSelectedModels,
    applyingGlobal,
    handleImplementIssue,
    handleGlobalAgentChange,
    handleGlobalModelChange,
    handleGlobalMultiToggle,
    handleGlobalMultiModelChange,
    handleApplyToAll,
    handleAgentChange,
    handleModelChange,
    handleRefresh,
  };
}
