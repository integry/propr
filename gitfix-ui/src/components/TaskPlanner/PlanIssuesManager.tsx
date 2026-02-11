import React, { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { AgentModelPair, PlanIssue } from '../../api/planIssuesApi';
import { PlanTask } from '../../api/plannerApi';
import PlanIssueRow from './PlanIssueRow';
import AgentModelSelector from './AgentModelSelector';
import SequentialWarningDialog from './SequentialWarningDialog';
import { usePlanIssuesManager } from './usePlanIssuesManager';

interface PlanIssuesManagerProps {
  draftId: string;
  tasks: PlanTask[];
  repository?: string;
  onRefresh?: () => void;
  onViewPlanClick?: () => void;
  /** Callback to report issues data to parent for footer stats */
  onIssuesChange?: (issues: PlanIssue[]) => void;
  /** Key to trigger refresh from parent */
  refreshKey?: number;
}

export const PlanIssuesManager: React.FC<PlanIssuesManagerProps> = ({
  draftId,
  tasks,
  repository,
  onRefresh,
  onViewPlanClick,
  onIssuesChange,
  refreshKey
}) => {
  const [showMerged, setShowMerged] = useState(false);
  const [showSequenceWarning, setShowSequenceWarning] = useState(false);
  const [pendingImplementIssue, setPendingImplementIssue] = useState<number | null>(null);
  const [pendingImplementModels, setPendingImplementModels] = useState<AgentModelPair[] | undefined>(undefined);

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
  } = usePlanIssuesManager({ draftId, tasks, onRefresh });

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
          )}
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
      />
    </div>
  );
};

export default PlanIssuesManager;
