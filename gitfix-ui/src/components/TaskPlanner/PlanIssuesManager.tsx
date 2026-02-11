import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, RefreshCw, Loader2, CheckCircle, AlertCircle, Github } from 'lucide-react';
import { AgentModelPair } from '../../api/planIssuesApi';
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
}

export const PlanIssuesManager: React.FC<PlanIssuesManagerProps> = ({
  draftId,
  tasks,
  repository,
  onRefresh,
  onViewPlanClick
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
    hasActiveIssues,
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
      <div className="flex items-center justify-between pb-3">
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
      {/* Continuous horizontal divider spanning full width */}
      <div className="-mx-4 border-b border-gray-200" />
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
