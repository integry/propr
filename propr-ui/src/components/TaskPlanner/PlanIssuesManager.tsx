import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronUp, Loader2, CheckCircle, AlertCircle, Layers, ArrowDownToLine, Info } from 'lucide-react';
import { AgentModelPair, PlanIssue } from '../../api/planIssuesApi';
import { PlanTask } from '../../api/plannerApi';
import PlanIssueRow from './PlanIssueRow';
import AgentModelSelector from './AgentModelSelector';
import SequentialWarningDialog from './SequentialWarningDialog';
import { usePlanIssuesManager } from './usePlanIssuesManager';
import { IssueCreationProgressIndicator } from './IssueCreationProgressIndicator';

interface PlanIssuesManagerProps {
  draftId: string;
  tasks: PlanTask[];
  onRefresh?: () => void;
  onViewPlanClick?: () => void;
  /** Callback to report issues data to parent for footer stats */
  onIssuesChange?: (issues: PlanIssue[]) => void;
  /** Key to trigger refresh from parent */
  refreshKey?: number;
  /** Whether to create an Epic PR to collect all issue PRs */
  useEpic?: boolean;
  /** Whether to auto-merge individual PRs into the Epic PR */
  autoMerge?: boolean;
  /** Callback when useEpic changes */
  onUseEpicChange?: (value: boolean) => void;
  /** Callback when autoMerge changes */
  onAutoMergeChange?: (value: boolean) => void;
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
  onUseEpicChange,
  onAutoMergeChange
}) => {
  const [showMerged, setShowMerged] = useState(false);
  const [showSequenceWarning, setShowSequenceWarning] = useState(false);
  const [pendingImplementIssue, setPendingImplementIssue] = useState<number | null>(null);
  const [pendingImplementModels, setPendingImplementModels] = useState<AgentModelPair[] | undefined>(undefined);

  // Track if the initial merged view expansion check has run (for fully merged plans)
  const hasInitializedMergedView = useRef(false);

  const {
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
  } = usePlanIssuesManager({ draftId, tasks, onRefresh, useEpic, autoMerge });

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

  // Compute unmerged issues for the warning dialog
  const warningUnmergedIssues = useMemo(() => {
    if (pendingImplementIssue === null) return [];
    return getUnmergedIssuesBefore(pendingImplementIssue);
  }, [pendingImplementIssue, getUnmergedIssuesBefore]);

  // Report issues to parent for footer stats
  useEffect(() => {
    onIssuesChange?.(issues);
  }, [issues, onIssuesChange]);

  // Trigger refresh when refreshKey changes (from parent footer button)
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey > 0) {
      handleRefresh();
    }
  }, [refreshKey, handleRefresh]);

  // Auto-expand merged issues when plan is fully merged (no active issues)
  useEffect(() => {
    // Only run once when loading completes and issues are available
    if (!loading && issues.length > 0 && !hasInitializedMergedView.current) {
      hasInitializedMergedView.current = true;
      // If there are no active issues but there are merged issues, auto-expand
      if (activeIssues.length === 0 && mergedIssues.length > 0) {
        setShowMerged(true);
      }
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
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
          <AlertCircle size={16} />
          {error}
          <button
            onClick={clearError}
            className="ml-auto text-red-500 hover:text-red-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Issue Creation Progress Indicator */}
      <AnimatePresence>
        {issueCreationProgress.status !== 'idle' && (
          <IssueCreationProgressIndicator
            progress={issueCreationProgress}
            onDismiss={issueCreationProgress.status !== 'in_progress' ? resetIssueCreationProgress : undefined}
          />
        )}
      </AnimatePresence>

      {/* Unified Execution Options Toolbar */}
      {pendingCount > 0 && (
        <div className="flex flex-col gap-3 sm:gap-4 py-3 border-y border-gray-200 bg-slate-50 px-3 sm:px-4 -mx-4 mb-4">
          {/* Agent Assignment Row */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex-shrink-0">
              Agent
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <AgentModelSelector
                agents={agents}
                selectedAgent={globalAgent}
                selectedModel={globalModel}
                onAgentChange={handleGlobalAgentChange}
                onModelChange={handleGlobalModelChange}
                disabled={applyingGlobal}
                compact
                isMulti={globalIsMulti}
                onMultiToggle={handleGlobalMultiToggle}
                selectedModels={globalSelectedModels}
                onMultiModelChange={handleGlobalMultiModelChange}
                onMultiConfirm={handleApplyToAll}
                autoOpenMultiDropdown
              />
              {!globalIsMulti && (
                <button
                  onClick={handleApplyToAll}
                  disabled={!globalAgent || applyingGlobal}
                  className="inline-flex items-center gap-1.5 px-2 sm:px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md bg-blue-600 text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                >
                  {applyingGlobal ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span className="hidden sm:inline">Applying...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle size={14} />
                      <span className="hidden sm:inline">Apply to All</span>
                      <span className="sm:hidden">Apply</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* PR Options Row */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6">
            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex-shrink-0">
              PR Options
            </span>
            <div className="flex flex-wrap items-center gap-3 sm:gap-6">
              <label
                className="flex items-center gap-2 text-xs sm:text-sm text-gray-700 cursor-pointer select-none"
                title="Automatically merges the PR when all CI checks pass"
              >
                <input
                  type="checkbox"
                  checked={autoMerge || false}
                  onChange={(e) => onAutoMergeChange?.(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                />
                <ArrowDownToLine size={14} className="text-slate-500 hidden sm:block" />
                <span>Auto-merge <span className="hidden sm:inline">if checks pass</span></span>
                <Info size={14} className="text-slate-400 hover:text-slate-600 transition-colors" />
              </label>
              {tasks.length >= 2 && (
                <label
                  className="flex items-center gap-2 text-xs sm:text-sm text-gray-700 cursor-pointer select-none"
                  title="Creates an overarching PR that aggregates all individual task PRs"
                >
                  <input
                    type="checkbox"
                    checked={useEpic || false}
                    onChange={(e) => onUseEpicChange?.(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                  />
                  <Layers size={14} className="text-slate-500 hidden sm:block" />
                  <span>Epic PR</span>
                  <Info size={14} className="text-slate-400 hover:text-slate-600 transition-colors" />
                </label>
              )}
            </div>
          </div>
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
