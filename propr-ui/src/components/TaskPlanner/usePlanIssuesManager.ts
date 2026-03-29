import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { PlanIssue, STATUS_CONFIG, getPlanIssues, implementIssue, updatePlanIssue, AgentModelPair } from '../../api/planIssuesApi';
import { AgentConfig, getAgents } from '../../api/proprApi';
import { PlanTask } from '../../api/plannerApi';
import { useSocket } from '../../contexts/useSocket';
import { DraftUpdatePayload } from '@propr/shared';

/** Progress state for issue creation via WebSocket */
export interface IssueCreationProgress {
  status: 'idle' | 'in_progress' | 'completed' | 'failed';
  createdCount: number;
  totalCount: number;
  failedCount: number;
  lastCreatedIssue?: {
    number: number;
    url: string;
    title: string;
  };
  error?: string;
}

/** Data payload for execution step updates */
interface ExecutionStepData {
  createdCount?: number;
  totalCount?: number;
  failedCount?: number;
  lastCreatedIssue?: { number: number; url: string; title: string };
  error?: string;
}

/** Create progress state from execution step data */
function createProgressState(
  status: IssueCreationProgress['status'],
  data: ExecutionStepData | undefined
): IssueCreationProgress {
  return {
    status,
    createdCount: data?.createdCount ?? 0,
    totalCount: data?.totalCount ?? 0,
    failedCount: data?.failedCount ?? 0,
    lastCreatedIssue: status === 'in_progress' ? data?.lastCreatedIssue : undefined,
    error: status === 'failed' ? (data?.error || 'Issue creation failed') : undefined
  };
}

interface UsePlanIssuesManagerProps {
  draftId: string;
  tasks: PlanTask[];
  onRefresh?: () => void;
  /** Whether to create an Epic PR to collect all issue PRs */
  useEpic?: boolean;
  /** Whether to auto-merge individual PRs into the Epic PR */
  autoMerge?: boolean;
  /** Current draft status - used to initialize progress when 'executing' */
  draftStatus?: string;
  /** Callback when issue creation completes successfully */
  onCreationComplete?: (createdCount: number, failedCount: number) => void;
}

export function usePlanIssuesManager({ draftId, tasks, onRefresh, useEpic, autoMerge, draftStatus, onCreationComplete }: UsePlanIssuesManagerProps) {
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

  // Track per-issue multi-mode state (applied from global selection)
  const [issueMultiModeMap, setIssueMultiModeMap] = useState<Record<number, boolean>>({});
  const [issueSelectedModelsMap, setIssueSelectedModelsMap] = useState<Record<number, AgentModelPair[]>>({});

  const { onTaskUpdate, onDraftUpdate, subscribeToDraft, unsubscribeFromDraft, isConnected } = useSocket();

  // Issue creation progress state (tracked via WebSocket DRAFT_UPDATE events)
  const [issueCreationProgress, setIssueCreationProgress] = useState<IssueCreationProgress>({
    status: 'idle',
    createdCount: 0,
    totalCount: 0,
    failedCount: 0
  });

  // Track if we've already handled completion to prevent duplicate callbacks
  const hasHandledCompletionRef = useRef(false);
  // Track last processed event timestamp to deduplicate (server sends to room AND globally)
  const lastEventTimestampRef = useRef<string | null>(null);

  // Update progress state when draftStatus changes to 'executing'
  // Don't reset progress if we just completed (hasHandledCompletionRef is true)
  useEffect(() => {
    if (draftStatus === 'executing' && issueCreationProgress.status === 'idle' && !hasHandledCompletionRef.current) {
      setIssueCreationProgress({
        status: 'in_progress',
        createdCount: 0,
        totalCount: tasks.length,
        failedCount: 0
      });
    }
  }, [draftStatus, tasks.length, issueCreationProgress.status]);

  const issueTitles = useMemo(() => {
    const map: Record<number, string> = {};
    tasks.forEach(task => { if (task.issue_number) map[task.issue_number] = task.title; });
    return map;
  }, [tasks]);

  // Map issue_number to full PlanTask for expandable details
  const issueTaskMap = useMemo(() => {
    const map: Record<number, PlanTask> = {};
    tasks.forEach(task => { if (task.issue_number) map[task.issue_number] = task; });
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

  const { activeIssues, mergedIssues, pendingCount, hasActiveIssues, firstPendingIssueNumber, sortedIssues } = useMemo(() => {
    const active: PlanIssue[] = [], merged: PlanIssue[] = [];
    let pending = 0, hasActive = false;

    const sorted = [...issuesWithDefaults].sort((a, b) => a.issue_number - b.issue_number);

    let firstUnmergedIssueNumber: number | null = null;
    for (const issue of sorted) {
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

    // When autoMerge or useEpic is enabled and there are pending issues,
    // keep polling so the UI can detect when the next pending issue transitions to processing
    if ((autoMerge || useEpic) && pending > 0) {
      hasActive = true;
    }

    return { activeIssues: active, mergedIssues: merged, pendingCount: pending, hasActiveIssues: hasActive, firstPendingIssueNumber: firstPending, sortedIssues: sorted };
  }, [issuesWithDefaults, autoMerge, useEpic]);

  // Get unmerged issues that come before a given issue number (for dependency warning)
  const getUnmergedIssuesBefore = useCallback((issueNumber: number) => {
    const unmerged: Array<{ issue_number: number; title?: string }> = [];
    for (const issue of sortedIssues) {
      if (issue.issue_number >= issueNumber) break;
      if (issue.status !== 'merged') {
        unmerged.push({
          issue_number: issue.issue_number,
          title: issueTitles[issue.issue_number]
        });
      }
    }
    return unmerged;
  }, [sortedIssues, issueTitles]);

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

  // Handle task update from WebSocket - refresh issues when any task changes
  const handleTaskUpdate = useCallback(async () => {
    // When any task updates, refresh issues to reflect the latest state
    console.log('[usePlanIssuesManager] Received task update via WebSocket');
    await fetchIssues();
  }, [fetchIssues]);

  // Handle draft update from WebSocket - track issue creation progress
  const handleDraftUpdate = useCallback(async (payload: DraftUpdatePayload) => {
    // Only handle updates for this draft and execution step
    if (payload.draftId !== draftId || payload.step !== 'execution') return;

    // Deduplicate events - server emits to room AND globally, so we receive each event twice
    if (payload.timestamp === lastEventTimestampRef.current) {
      console.log('[usePlanIssuesManager] Skipping duplicate draft update (same timestamp)');
      return;
    }
    lastEventTimestampRef.current = payload.timestamp;

    console.log('[usePlanIssuesManager] Received draft update via WebSocket:', payload);

    const data = payload.data as ExecutionStepData | undefined;
    const status = payload.status as IssueCreationProgress['status'];

    if (status === 'in_progress' || status === 'completed' || status === 'failed') {
      // Reset completion flag when a fresh execution starts (createdCount: 0)
      if (status === 'in_progress' && (data?.createdCount ?? 0) === 0) {
        hasHandledCompletionRef.current = false;
      }

      setIssueCreationProgress(createProgressState(status, data));

      // Only refresh issues when creation is done (not during - progress bar shows real-time status)
      if (status === 'completed' || status === 'failed') {
        await fetchIssues();
        // Note: Don't call onRefresh here - it causes unnecessary page refresh
        // The fetchIssues() call above already updates the issues list
        if (status === 'completed' && !hasHandledCompletionRef.current) {
          hasHandledCompletionRef.current = true;
          onCreationComplete?.(data?.createdCount ?? 0, data?.failedCount ?? 0);
          // Auto-reset progress state after completion - toast already shows success
          setIssueCreationProgress({
            status: 'idle',
            createdCount: 0,
            totalCount: 0,
            failedCount: 0
          });
        }
      }
    }
  }, [draftId, fetchIssues, onCreationComplete]);

  // Reset issue creation progress when issues change (e.g., after completion)
  const resetIssueCreationProgress = useCallback(() => {
    setIssueCreationProgress({
      status: 'idle',
      createdCount: 0,
      totalCount: 0,
      failedCount: 0
    });
  }, []);

  // Subscribe to WebSocket events for task updates when there are active issues
  useEffect(() => {
    if (!hasActiveIssues || !isConnected) return;

    // Listen for task updates (global listener since issues can map to any task)
    const unsubscribe = onTaskUpdate(handleTaskUpdate);

    return () => {
      unsubscribe();
    };
  }, [hasActiveIssues, isConnected, onTaskUpdate, handleTaskUpdate]);

  // Subscribe to WebSocket events for draft updates (issue creation progress)
  useEffect(() => {
    if (!draftId || !isConnected) return;

    // Subscribe to this specific draft's room
    subscribeToDraft(draftId);

    // Listen for draft updates (issue creation progress)
    const unsubscribe = onDraftUpdate(handleDraftUpdate);

    return () => {
      unsubscribeFromDraft(draftId);
      unsubscribe();
    };
  }, [draftId, isConnected, subscribeToDraft, unsubscribeFromDraft, onDraftUpdate, handleDraftUpdate]);

  const handleImplementIssue = useCallback(async (issueNumber: number, models?: AgentModelPair[]) => {
    setImplementingIssue(issueNumber);
    try {
      const options = models && models.length > 0
        ? { models, useEpic, autoMerge }
        : useEpic || autoMerge
          ? { useEpic, autoMerge }
          : undefined;
      await implementIssue(draftId, issueNumber, options);

      // Preserve selected models for display during processing (if multi-agent)
      if (models && models.length > 0) {
        setIssueMultiModeMap(prev => ({ ...prev, [issueNumber]: true }));
        setIssueSelectedModelsMap(prev => ({ ...prev, [issueNumber]: models }));
      }

      await fetchIssues();
      onRefresh?.();
    } catch (err) {
      console.error('Failed to implement issue:', err);
      setError('Failed to start implementation');
    } finally {
      setImplementingIssue(null);
    }
  }, [draftId, fetchIssues, onRefresh, useEpic, autoMerge]);

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
        // Multi-mode: apply the selected models to all pending issues
        // This sets the multi-mode state for each issue WITHOUT starting implementation
        // User still has to click "Implement" button manually
        const newMultiModeMap: Record<number, boolean> = { ...issueMultiModeMap };
        const newSelectedModelsMap: Record<number, AgentModelPair[]> = { ...issueSelectedModelsMap };
        pendingIssues.forEach(issue => {
          newMultiModeMap[issue.issue_number] = true;
          newSelectedModelsMap[issue.issue_number] = [...globalSelectedModels];
        });
        setIssueMultiModeMap(newMultiModeMap);
        setIssueSelectedModelsMap(newSelectedModelsMap);

        // Reset global multi-mode state
        setGlobalIsMulti(false);
        setGlobalSelectedModels([]);
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

        // Clear multi-mode state for all pending issues when applying single mode
        const newMultiModeMap: Record<number, boolean> = { ...issueMultiModeMap };
        const newSelectedModelsMap: Record<number, AgentModelPair[]> = { ...issueSelectedModelsMap };
        pendingIssues.forEach(issue => {
          newMultiModeMap[issue.issue_number] = false;
          newSelectedModelsMap[issue.issue_number] = [];
        });
        setIssueMultiModeMap(newMultiModeMap);
        setIssueSelectedModelsMap(newSelectedModelsMap);
      }
    } catch (err) {
      console.error('Failed to apply agent/model to all issues:', err);
      setError('Failed to apply agent/model to all issues');
    } finally {
      setApplyingGlobal(false);
    }
  }, [globalIsMulti, globalAgent, globalModel, globalSelectedModels, issues, draftId, issueMultiModeMap, issueSelectedModelsMap]);

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

  // Handlers for per-issue multi-mode state
  const handleIssueMultiToggle = useCallback((issueNumber: number, isMulti: boolean) => {
    setIssueMultiModeMap(prev => ({ ...prev, [issueNumber]: isMulti }));
    if (!isMulti) {
      setIssueSelectedModelsMap(prev => ({ ...prev, [issueNumber]: [] }));
    }
  }, []);

  const handleIssueMultiModelChange = useCallback((issueNumber: number, models: AgentModelPair[]) => {
    setIssueSelectedModelsMap(prev => ({ ...prev, [issueNumber]: models }));
  }, []);

  return {
    issues,
    agents,
    loading,
    error,
    clearError,
    implementingIssue,
    issueTitles,
    issueTaskMap,
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
    issueMultiModeMap,
    issueSelectedModelsMap,
    issueCreationProgress,
    resetIssueCreationProgress,
    handleImplementIssue,
    handleGlobalAgentChange,
    handleGlobalModelChange,
    handleGlobalMultiToggle,
    handleGlobalMultiModelChange,
    handleApplyToAll,
    handleAgentChange,
    handleModelChange,
    handleIssueMultiToggle,
    handleIssueMultiModelChange,
    handleRefresh,
    getUnmergedIssuesBefore,
  };
}
