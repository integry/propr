import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronUp, Loader2, Check, CheckCircle, AlertCircle, Layers, ArrowDownToLine, Info } from 'lucide-react';
import { AgentModelPair, PlanIssue, implementAllIssues } from '../../api/planIssuesApi';
import { PlanTask } from '../../api/plannerApi';
import PlanIssueRow from './PlanIssueRow';
import AgentModelSelector from './AgentModelSelector';
import SequentialWarningDialog from './SequentialWarningDialog';
import { usePlanIssuesManager } from './usePlanIssuesManager';
import { IssueCreationProgressIndicator } from './IssueCreationProgressIndicator';

/** Shows task rows with creation progress when issues are being created */
const TasksBeingCreated: React.FC<{
  tasks: PlanTask[];
  issueCreationProgress: { createdCount: number; lastCreatedIssue?: { number: number } | null };
}> = ({ tasks, issueCreationProgress }) => (
  <div className="relative pl-1">
    <div
      className="absolute left-[13px] top-2 bottom-2 w-0.5 bg-slate-200"
      style={{ zIndex: 0 }}
    />
    <div className="relative" style={{ zIndex: 1 }}>
      {tasks.map((task, index) => {
        const isCreated = index < issueCreationProgress.createdCount;
        const isCreating = index === issueCreationProgress.createdCount;
        const lastCreated = issueCreationProgress.lastCreatedIssue;
        const issueNumber = isCreated && lastCreated && index === issueCreationProgress.createdCount - 1
          ? lastCreated.number
          : null;

        return (
          <div
            key={task.id || index}
            className="flex items-center gap-2.5 py-1 group"
          >
            <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center bg-white rounded-full">
              {isCreated ? (
                <div className="w-4 h-4 rounded-full bg-gray-100 flex items-center justify-center">
                  <Check size={10} className="text-gray-400" strokeWidth={3} />
                </div>
              ) : isCreating ? (
                <Loader2 size={14} className="text-blue-600 animate-spin" />
              ) : (
                <div className="w-3 h-3 rounded-full border-2 border-gray-300 bg-white" />
              )}
            </div>
            <span className={`flex-1 text-sm truncate ${
              isCreated ? 'text-gray-400' :
              isCreating ? 'text-blue-700 font-medium' :
              'text-gray-500'
            }`}>
              {task.title}
            </span>
            {issueNumber && (
              <span className="flex-shrink-0 px-1.5 py-0.5 bg-gray-100 rounded text-[10px] font-mono text-gray-500">
                #{issueNumber}
              </span>
            )}
          </div>
        );
      })}
    </div>
  </div>
);

interface ExecutionOptionsToolbarProps {
  agents: ReturnType<typeof usePlanIssuesManager>['agents'];
  globalAgent: string; globalModel: string; globalIsMulti: boolean;
  globalSelectedModels: AgentModelPair[]; applyingGlobal: boolean;
  handleGlobalAgentChange: (agent: string) => void;
  handleGlobalModelChange: (model: string) => void;
  handleGlobalMultiToggle: (isMulti: boolean) => void;
  handleGlobalMultiModelChange: (models: AgentModelPair[]) => void;
  handleApplyToAll: () => void;
  autoMerge?: boolean; onAutoMergeChange?: (value: boolean) => void;
  useEpic?: boolean; onUseEpicChange?: (value: boolean) => void;
  runUltrafix?: boolean; onRunUltrafixChange?: (value: boolean) => void;
  ultrafixGoal?: number | null; onUltrafixGoalChange?: (value: number | null) => void;
  ultrafixMaxCycles?: number | null; onUltrafixMaxCyclesChange?: (value: number | null) => void;
  tasks: PlanTask[]; pendingCount: number;
  implementingAll: boolean; handleImplementAll: () => void;
}

/** Toolbar with agent selection, PR options, and implement-all button */
const ExecutionOptionsToolbar: React.FC<ExecutionOptionsToolbarProps> = ({
  agents, globalAgent, globalModel, globalIsMulti, globalSelectedModels,
  applyingGlobal, handleGlobalAgentChange, handleGlobalModelChange,
  handleGlobalMultiToggle, handleGlobalMultiModelChange, handleApplyToAll,
  autoMerge, onAutoMergeChange, useEpic, onUseEpicChange,
  runUltrafix, onRunUltrafixChange, ultrafixGoal, onUltrafixGoalChange, ultrafixMaxCycles, onUltrafixMaxCyclesChange,
  tasks, pendingCount, implementingAll, handleImplementAll,
}) => (
  <div className="flex flex-col gap-2.5 sm:gap-3 py-2.5 border-b border-slate-200 bg-slate-50 px-3 sm:px-4 -mx-4 mb-3">
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
      <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex-shrink-0">Agent</span>
      <div className="flex flex-wrap items-center gap-2">
        <AgentModelSelector
          agents={agents} selectedAgent={globalAgent} selectedModel={globalModel}
          onAgentChange={handleGlobalAgentChange} onModelChange={handleGlobalModelChange}
          disabled={applyingGlobal} compact isMulti={globalIsMulti}
          onMultiToggle={handleGlobalMultiToggle} selectedModels={globalSelectedModels}
          onMultiModelChange={handleGlobalMultiModelChange}
          onMultiConfirm={handleApplyToAll} autoOpenMultiDropdown
        />
        {!globalIsMulti && (
          <button
            onClick={handleApplyToAll}
            disabled={!globalAgent || applyingGlobal}
            className="inline-flex items-center gap-1.5 px-2 sm:px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md bg-blue-600 text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {applyingGlobal ? (
              <><Loader2 size={14} className="animate-spin" /><span className="hidden sm:inline">Applying...</span></>
            ) : (
              <><CheckCircle size={14} /><span className="hidden sm:inline">Apply to All</span><span className="sm:hidden">Apply</span></>
            )}
          </button>
        )}
      </div>
    </div>
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6">
      <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex-shrink-0">PR Options</span>
      <div className="flex flex-wrap items-center gap-3 sm:gap-6">
        <label className="flex items-center gap-2 text-xs sm:text-sm text-gray-700 cursor-pointer select-none" title="Automatically merges the PR when all CI checks pass">
          <input type="checkbox" checked={autoMerge || false} onChange={(e) => onAutoMergeChange?.(e.target.checked)} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer" />
          <ArrowDownToLine size={14} className="text-slate-500 hidden sm:block" />
          <span>Auto-merge <span className="hidden sm:inline">if checks pass</span></span>
          <Info size={14} className="text-slate-400 hover:text-slate-600 transition-colors" />
        </label>
        {tasks.length >= 2 && (
          <label className="flex items-center gap-2 text-xs sm:text-sm text-gray-700 cursor-pointer select-none" title="Creates an overarching PR that aggregates all individual task PRs">
            <input type="checkbox" checked={useEpic || false} onChange={(e) => onUseEpicChange?.(e.target.checked)} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer" />
            <Layers size={14} className="text-slate-500 hidden sm:block" />
            <span>Epic PR</span>
            <Info size={14} className="text-slate-400 hover:text-slate-600 transition-colors" />
          </label>
        )}
        <label className="flex items-center gap-2 text-xs sm:text-sm text-gray-700 cursor-pointer select-none" title="Automatically run ultrafix after the PR is opened">
          <input type="checkbox" checked={runUltrafix || false} onChange={(e) => onRunUltrafixChange?.(e.target.checked)} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer" />
          <span>Run ultrafix after PR</span>
        </label>
        <input
          type="number"
          min={1}
          max={10}
          value={ultrafixGoal ?? ''}
          onChange={(e) => onUltrafixGoalChange?.(e.target.value === '' ? null : Number(e.target.value))}
          placeholder="UF goal"
          className="w-24 rounded-md border border-slate-300 px-2 py-1 text-xs sm:text-sm"
        />
        <input
          type="number"
          min={1}
          value={ultrafixMaxCycles ?? ''}
          onChange={(e) => onUltrafixMaxCyclesChange?.(e.target.value === '' ? null : Number(e.target.value))}
          placeholder="UF max"
          className="w-24 rounded-md border border-slate-300 px-2 py-1 text-xs sm:text-sm"
        />
      </div>
    </div>
    {pendingCount >= 2 && autoMerge && useEpic && (
      <div className="flex items-center justify-end pt-1 border-t border-slate-200/50">
        <button
          onClick={handleImplementAll}
          disabled={implementingAll || !globalAgent}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-green-600 text-white shadow-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={!globalAgent ? 'Select an agent first' : 'Start sequential implementation: each issue will be processed and merged before the next one starts'}
        >
          {implementingAll ? (
            <><Loader2 size={16} className="animate-spin" /><span>Starting sequence...</span></>
          ) : (
            <><CheckCircle size={16} /><span>Run All Sequentially ({pendingCount})</span></>
          )}
        </button>
      </div>
    )}
  </div>
);

interface PlanIssuesManagerProps {
  draftId: string;
  tasks: PlanTask[];
  onRefresh?: () => void;
  onViewPlanClick?: () => void;
  onIssuesChange?: (issues: PlanIssue[]) => void;
  refreshKey?: number;
  useEpic?: boolean;
  autoMerge?: boolean;
  runUltrafix?: boolean;
  ultrafixGoal?: number | null;
  ultrafixMaxCycles?: number | null;
  onUseEpicChange?: (value: boolean) => void;
  onAutoMergeChange?: (value: boolean) => void;
  onRunUltrafixChange?: (value: boolean) => void;
  onUltrafixGoalChange?: (value: number | null) => void;
  onUltrafixMaxCyclesChange?: (value: number | null) => void;
  draftStatus?: string;
  onCreationComplete?: (createdCount: number, failedCount: number) => void;
}

export const PlanIssuesManager: React.FC<PlanIssuesManagerProps> = ({
  draftId,
  tasks,
  onRefresh,
  onViewPlanClick,
  onIssuesChange,
  refreshKey,
  useEpic,
  autoMerge,
  runUltrafix,
  ultrafixGoal,
  ultrafixMaxCycles,
  onUseEpicChange,
  onAutoMergeChange,
  onRunUltrafixChange,
  onUltrafixGoalChange,
  onUltrafixMaxCyclesChange,
  draftStatus,
  onCreationComplete
}) => {
  const [showMerged, setShowMerged] = useState(false);
  const [showSequenceWarning, setShowSequenceWarning] = useState(false);
  const [pendingImplementIssue, setPendingImplementIssue] = useState<number | null>(null);
  const [pendingImplementModels, setPendingImplementModels] = useState<AgentModelPair[] | undefined>(undefined);
  const [implementingAll, setImplementingAll] = useState(false);
  const hasInitializedMergedView = useRef(false);

  const {
    issues, agents, loading, error, clearError, implementingIssue,
    issueTitles, issueTaskMap, activeIssues, mergedIssues,
    pendingCount, firstPendingIssueNumber,
    globalAgent, globalModel, globalIsMulti, globalSelectedModels, applyingGlobal,
    issueMultiModeMap, issueSelectedModelsMap,
    issueCreationProgress, resetIssueCreationProgress,
    handleImplementIssue, handleGlobalAgentChange, handleGlobalModelChange,
    handleGlobalMultiToggle, handleGlobalMultiModelChange, handleApplyToAll,
    handleAgentChange, handleModelChange,
    handleRunUltrafixChange, handleUltrafixGoalChange, handleUltrafixMaxCyclesChange,
    handleIssueMultiToggle, handleIssueMultiModelChange,
    handleRefresh, getUnmergedIssuesBefore,
  } = usePlanIssuesManager({ draftId, tasks, onRefresh, useEpic, autoMerge, draftStatus, onCreationComplete });

  const handleImplementWithWarning = useCallback((issueNumber: number, models?: AgentModelPair[]) => {
    setPendingImplementIssue(issueNumber);
    setPendingImplementModels(models);
    setShowSequenceWarning(true);
  }, []);

  const handleCloseWarning = useCallback(() => {
    setShowSequenceWarning(false);
    setPendingImplementIssue(null);
    setPendingImplementModels(undefined);
  }, []);

  const handleProceedAnyway = useCallback(async () => {
    if (pendingImplementIssue !== null) {
      setShowSequenceWarning(false);
      await handleImplementIssue(pendingImplementIssue, pendingImplementModels);
      setPendingImplementIssue(null);
      setPendingImplementModels(undefined);
    }
  }, [pendingImplementIssue, pendingImplementModels, handleImplementIssue]);

  const warningUnmergedIssues = useMemo(() => {
    if (pendingImplementIssue === null) return [];
    return getUnmergedIssuesBefore(pendingImplementIssue);
  }, [pendingImplementIssue, getUnmergedIssuesBefore]);

  const handleImplementAll = useCallback(async () => {
    if (pendingCount === 0) return;
    setImplementingAll(true);
    try {
      await implementAllIssues(draftId, { useEpic, autoMerge });
      handleRefresh();
    } catch (err) {
      console.error('Failed to implement all issues:', err);
    } finally {
      setImplementingAll(false);
    }
  }, [draftId, pendingCount, useEpic, autoMerge, handleRefresh]);

  useEffect(() => { onIssuesChange?.(issues); }, [issues, onIssuesChange]);

  useEffect(() => {
    if (refreshKey !== undefined && refreshKey > 0) handleRefresh();
  }, [refreshKey, handleRefresh]);

  useEffect(() => {
    if (!loading && issues.length > 0 && !hasInitializedMergedView.current) {
      hasInitializedMergedView.current = true;
      if (activeIssues.length === 0 && mergedIssues.length > 0) setShowMerged(true);
    }
  }, [loading, issues.length, activeIssues.length, mergedIssues.length]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-500">
        <Loader2 className="animate-spin mr-2" size={20} />
        <span>Loading issues...</span>
      </div>
    );
  }

  // Show empty state only if no issues AND not currently creating
  if (issues.length === 0 && issueCreationProgress.status === 'idle') {
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
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
          <AlertCircle size={16} />
          {error}
          <button onClick={clearError} className="ml-auto text-red-500 hover:text-red-700">Dismiss</button>
        </div>
      )}
      <AnimatePresence>
        {issueCreationProgress.status !== 'idle' && (
          <IssueCreationProgressIndicator
            progress={issueCreationProgress}
            onDismiss={issueCreationProgress.status !== 'in_progress' ? resetIssueCreationProgress : undefined}
          />
        )}
      </AnimatePresence>
      {issues.length === 0 && issueCreationProgress.status === 'in_progress' && (
        <TasksBeingCreated tasks={tasks} issueCreationProgress={issueCreationProgress} />
      )}
      {pendingCount > 0 && (
        <ExecutionOptionsToolbar
          agents={agents}
          globalAgent={globalAgent}
          globalModel={globalModel}
          globalIsMulti={globalIsMulti}
          globalSelectedModels={globalSelectedModels}
          applyingGlobal={applyingGlobal}
          handleGlobalAgentChange={handleGlobalAgentChange}
          handleGlobalModelChange={handleGlobalModelChange}
          handleGlobalMultiToggle={handleGlobalMultiToggle}
          handleGlobalMultiModelChange={handleGlobalMultiModelChange}
          handleApplyToAll={handleApplyToAll}
          autoMerge={autoMerge}
          onAutoMergeChange={onAutoMergeChange}
          useEpic={useEpic}
          onUseEpicChange={onUseEpicChange}
          runUltrafix={runUltrafix}
          onRunUltrafixChange={onRunUltrafixChange}
          ultrafixGoal={ultrafixGoal}
          onUltrafixGoalChange={onUltrafixGoalChange}
          ultrafixMaxCycles={ultrafixMaxCycles}
          onUltrafixMaxCyclesChange={onUltrafixMaxCyclesChange}
          tasks={tasks}
          pendingCount={pendingCount}
          implementingAll={implementingAll}
          handleImplementAll={handleImplementAll}
        />
      )}
      <div className="space-y-1.5">
        {activeIssues.map(issue => (
          <PlanIssueRow
            key={issue.id}
            issue={issue}
            issueTitle={issueTitles[issue.issue_number]}
            agents={agents}
            onImplement={handleImplementIssue}
            onAgentChange={handleAgentChange}
            onModelChange={handleModelChange}
            onRunUltrafixChange={handleRunUltrafixChange}
            onUltrafixGoalChange={handleUltrafixGoalChange}
            onUltrafixMaxCyclesChange={handleUltrafixMaxCyclesChange}
            implementing={implementingIssue === issue.issue_number}
            isFirstPending={issue.status === 'pending' && issue.issue_number === firstPendingIssueNumber}
            onImplementWithWarning={handleImplementWithWarning}
            inheritedIsMulti={issueMultiModeMap[issue.issue_number]}
            inheritedSelectedModels={issueSelectedModelsMap[issue.issue_number]}
            onMultiToggle={(isMulti) => handleIssueMultiToggle(issue.issue_number, isMulti)}
            onMultiModelChange={(models) => handleIssueMultiModelChange(issue.issue_number, models)}
            task={issueTaskMap[issue.issue_number]}
            draftId={draftId}
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
            {showMerged ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
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
                    onRunUltrafixChange={handleRunUltrafixChange}
                    onUltrafixGoalChange={handleUltrafixGoalChange}
                    onUltrafixMaxCyclesChange={handleUltrafixMaxCyclesChange}
                    implementing={false}
                    task={issueTaskMap[issue.issue_number]}
                    draftId={draftId}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <SequentialWarningDialog
        isOpen={showSequenceWarning}
        onClose={handleCloseWarning}
        onProceed={handleProceedAnyway}
        unmergedIssues={warningUnmergedIssues}
      />
    </div>
  );
};

export default PlanIssuesManager;
