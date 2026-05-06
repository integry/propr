import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, Github, GitMerge, FileQuestion, GitBranch, X, RefreshCw, Trash2, Loader2, Edit3, Pause, Play } from 'lucide-react';
import { DraftWithPlan, deleteDraft } from '../../api/proprApi';
import DeletePlanDialog from './DeletePlanDialog';
import RevisePlanDialog from './RevisePlanDialog';
import PlanIssuesManager from './PlanIssuesManager';
import { PlanTask, reviseDraft, pauseDraft, resumeDraft, updateExecutionSettings } from '../../api/plannerApi';
import { PlanIssue } from '../../api/planIssuesApi';
import { useToast } from '../ui/useToast';

interface ApprovedPlanViewProps {
  draft: DraftWithPlan;
  onRefetch?: () => void;
}
const OriginalPromptPopover: React.FC<{ prompt: string }> = ({ prompt }) => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-full transition-colors"
        style={{ color: 'rgb(29, 138, 138)' }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(29, 138, 138, 0.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
        title="View original prompt"
      >
        <FileQuestion size={14} />
        <span className="hidden sm:inline font-medium">Prompt</span>
      </button>
      <AnimatePresence>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="absolute top-full left-0 mt-2 z-50 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden"
            >
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Original Prompt</span>
                <button onClick={() => setIsOpen(false)} className="p-1 hover:bg-gray-200 rounded transition-colors">
                  <X size={14} className="text-gray-400" />
                </button>
              </div>
              <div className="p-3 max-h-60 overflow-y-auto">
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{prompt}</p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

interface FooterStats {
  total: number;
  merged: number;
  underReview: number;
  pending: number;
  processing: number;
}
const PlanFooterStats: React.FC<{ stats: FooterStats; onRefresh: () => void }> = ({ stats, onRefresh }) => (
  <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-t border-gray-200 bg-gray-100 flex-shrink-0">
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs sm:text-sm text-gray-600">
      <span className="font-medium">{stats.total} {stats.total === 1 ? 'Issue' : 'Issues'}</span>
      {stats.merged > 0 && (
        <>
          <span className="text-gray-400">•</span>
          <span className="text-purple-600">{stats.merged} Merged</span>
        </>
      )}
      {stats.processing > 0 && (
        <>
          <span className="text-gray-400">•</span>
          <span className="text-amber-600">{stats.processing} Processing</span>
        </>
      )}
      {stats.pending > 0 && (
        <>
          <span className="text-gray-400">•</span>
          <span className="text-gray-500">{stats.pending} Pending</span>
        </>
      )}
    </div>
    <button
      onClick={onRefresh}
      className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors flex-shrink-0"
      title="Refresh issues"
    >
      <RefreshCw size={16} />
    </button>
  </div>
);

interface PlanHeaderActionsProps {
  draftStatus: string;
  isPaused: boolean;
  isPauseLoading: boolean;
  isRevising: boolean;
  isDeleting: boolean;
  repoUrl: string | null;
  onPauseResume: () => void;
  onRevise: () => void;
  onDelete: () => void;
}

function parsePlanTasks(planJson: DraftWithPlan['plan_json']): PlanTask[] {
  if (typeof planJson === 'string') {
    try {
      const parsed = JSON.parse(planJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return Array.isArray(planJson) ? planJson : [];
}

function buildFooterStats(issues: PlanIssue[]): FooterStats {
  return {
    total: issues.length,
    merged: issues.filter(i => i.status === 'merged').length,
    underReview: issues.filter(i => i.status === 'pr_open' || i.status === 'pr_review').length,
    pending: issues.filter(i => i.status === 'pending').length,
    processing: issues.filter(i => i.status === 'processing' || i.status === 'refinement_processing').length,
  };
}

async function persistExecutionSetting(
  draftId: string,
  update: Parameters<typeof updateExecutionSettings>[1],
): Promise<Awaited<ReturnType<typeof updateExecutionSettings>>> {
  return updateExecutionSettings(draftId, update);
}

const PlanHeaderActions: React.FC<PlanHeaderActionsProps> = ({
  draftStatus,
  isPaused,
  isPauseLoading,
  isRevising,
  isDeleting,
  repoUrl,
  onPauseResume,
  onRevise,
  onDelete
}) => {
  const showPauseResume = draftStatus === 'executed' || draftStatus === 'pr_created';
  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      {showPauseResume && (
        <button
          onClick={onPauseResume}
          disabled={isPauseLoading}
          className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            isPaused
              ? 'text-green-600 hover:text-green-700 hover:bg-green-50'
              : 'text-orange-600 hover:text-orange-700 hover:bg-orange-50'
          }`}
          title={isPaused ? 'Resume plan execution' : 'Pause plan execution'}
        >
          {isPauseLoading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : isPaused ? (
            <Play size={16} />
          ) : (
            <Pause size={16} />
          )}
          <span className="hidden sm:inline">{isPaused ? 'Resume' : 'Pause'}</span>
        </button>
      )}
      <button
        onClick={onRevise}
        disabled={isRevising}
        className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 text-sm text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title="Revise Plan"
      >
        {isRevising ? <Loader2 size={16} className="animate-spin" /> : <Edit3 size={16} />}
        <span className="hidden sm:inline">Revise</span>
      </button>
      <button
        onClick={onDelete}
        disabled={isDeleting}
        className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title="Delete Plan"
      >
        {isDeleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
      </button>
      {repoUrl && (
        <>
          <div className="h-6 w-px bg-gray-300 mx-1 hidden sm:block" />
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors text-sm"
          >
            <Github size={16} />
            <span className="hidden sm:inline">View Issues on GitHub</span>
            <ExternalLink size={14} />
          </a>
        </>
      )}
    </div>
  );
};

interface PlanHeaderSummaryProps {
  planName: string;
  draftStatus: string;
  isPaused: boolean;
  repository: string;
  baseBranch: string;
  initialPrompt?: string | null;
}

const PlanHeaderSummary: React.FC<PlanHeaderSummaryProps> = ({
  planName,
  draftStatus,
  isPaused,
  repository,
  baseBranch,
  initialPrompt,
}) => (
  <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
    <h1 className="text-base sm:text-lg font-semibold text-gray-900 truncate min-w-0 flex-shrink" title={planName}>
      {planName}
    </h1>
    {draftStatus === 'merged' && (
      <span className="px-2 py-1 rounded text-xs font-medium bg-purple-100 text-purple-700 flex items-center gap-1 flex-shrink-0">
        <GitMerge size={12} /><span className="hidden sm:inline">Merged</span>
      </span>
    )}
    {isPaused && (
      <span className="px-2 py-1 rounded text-xs font-medium bg-orange-100 text-orange-700 flex items-center gap-1 flex-shrink-0">
        <Pause size={12} /><span className="hidden sm:inline">Paused</span>
      </span>
    )}
    <div className="hidden md:flex items-center gap-2 text-sm flex-shrink-0">
      <div className="h-4 w-px bg-gray-300" />
      <Github size={16} className="text-gray-500" />
      <span className="font-medium text-gray-900 truncate max-w-[200px]" title={repository}>{repository}</span>
      <span className="text-gray-400">/</span>
      <GitBranch size={14} className="text-gray-500" />
      <span className="text-gray-600">{baseBranch}</span>
    </div>
    {initialPrompt && (
      <>
        <div className="h-4 w-px bg-gray-300 flex-shrink-0 hidden lg:block" />
        <div className="hidden lg:block"><OriginalPromptPopover prompt={initialPrompt} /></div>
      </>
    )}
  </div>
);

export const ApprovedPlanView: React.FC<ApprovedPlanViewProps> = ({ draft, onRefetch }) => {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [issues, _setIssues] = useState<PlanIssue[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showReviseDialog, setShowReviseDialog] = useState(false);
  const [isRevising, setIsRevising] = useState(false);
  const [isPaused, setIsPaused] = useState(draft.paused || false);
  const [isPauseLoading, setIsPauseLoading] = useState(false);
  const [useEpic, setUseEpic] = useState(draft.context_config?.useEpic ?? false);
  const [autoMerge, setAutoMerge] = useState(draft.context_config?.autoMerge ?? false);
  const [runUltrafix, setRunUltrafix] = useState(draft.context_config?.runUltrafix ?? false);
  const [ultrafixGoal, setUltrafixGoal] = useState<number | null>(draft.context_config?.ultrafixGoal ?? null);
  const [ultrafixMaxCycles, setUltrafixMaxCycles] = useState<number | null>(draft.context_config?.ultrafixMaxCycles ?? null);

  const planName = draft.name || draft.initial_prompt || 'Untitled Plan';
  const repository = draft.repository || '';
  const baseBranch = draft.context_config?.baseBranch || 'main';
  const repoUrl = draft.repository ? `https://github.com/${draft.repository}/issues` : null;
  const tasks: PlanTask[] = useMemo(() => parsePlanTasks(draft.plan_json), [draft.plan_json]);
  const footerStats = useMemo(() => buildFooterStats(issues), [issues]);

  const handleDeletePlanConfirm = useCallback(async () => {
    setIsDeleting(true);
    try {
      await deleteDraft(draft.draft_id);
      setShowDeleteDialog(false);
      addToast({ type: 'success', message: 'Plan deleted successfully', duration: 3000 });
      navigate('/plans');
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message || 'Failed to delete plan', duration: 5000 });
    } finally {
      setIsDeleting(false);
    }
  }, [draft.draft_id, addToast, navigate]);

  const handlePauseResume = useCallback(async () => {
    setIsPauseLoading(true);
    try {
      if (isPaused) {
        await resumeDraft(draft.draft_id);
        setIsPaused(false);
        addToast({ type: 'success', message: 'Plan execution resumed', duration: 3000 });
      } else {
        await pauseDraft(draft.draft_id);
        setIsPaused(true);
        addToast({ type: 'success', message: 'Plan execution paused. Current task will complete, but next task won\'t start.', duration: 4000 });
      }
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message || `Failed to ${isPaused ? 'resume' : 'pause'} plan`, duration: 5000 });
    } finally {
      setIsPauseLoading(false);
    }
  }, [draft.draft_id, isPaused, addToast]);

  const handleRevisePlanConfirm = useCallback(async () => {
    setIsRevising(true);
    try {
      const result = await reviseDraft(draft.draft_id);
      setShowReviseDialog(false);
      const message = result.issuesDetached > 0
        ? `Plan revised successfully. ${result.issuesDetached} issue(s) detached.`
        : 'Plan revised successfully.';
      addToast({ type: 'success', message, duration: 3000 });
      onRefetch?.();
    } catch (err) {
      addToast({ type: 'error', message: (err as Error).message || 'Failed to revise plan', duration: 5000 });
    } finally {
      setIsRevising(false);
    }
  }, [draft.draft_id, addToast, onRefetch]);

  const handleRefresh = useCallback(() => setRefreshKey(prev => prev + 1), []);
  const handleIssuesChange = useCallback((newIssues: PlanIssue[]) => _setIssues(newIssues), []);

  const handleCreationComplete = useCallback((createdCount: number, failedCount: number) => {
    if (failedCount > 0) {
      addToast({
        type: 'warning',
        message: `Created ${createdCount} issue${createdCount !== 1 ? 's' : ''}, ${failedCount} failed`,
        duration: 5000
      });
    } else {
      addToast({
        type: 'success',
        message: `Successfully created ${createdCount} GitHub issue${createdCount !== 1 ? 's' : ''}`,
        duration: 4000
      });
    }
  }, [addToast]);

  const handleUseEpicChange = useCallback(async (value: boolean) => {
    const previousValue = useEpic;
    setUseEpic(value);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { useEpic: value });
      setUseEpic(saved.useEpic);
    } catch (err) {
      setUseEpic(previousValue);
      addToast({ type: 'error', message: (err as Error).message || 'Failed to save Epic PR setting', duration: 5000 });
    }
  }, [addToast, draft.draft_id, useEpic]);

  const handleAutoMergeChange = useCallback(async (value: boolean) => {
    const previousValue = autoMerge;
    setAutoMerge(value);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { autoMerge: value });
      setAutoMerge(saved.autoMerge);
    } catch (err) {
      setAutoMerge(previousValue);
      addToast({ type: 'error', message: (err as Error).message || 'Failed to save auto-merge setting', duration: 5000 });
    }
  }, [addToast, autoMerge, draft.draft_id]);

  const handleRunUltrafixChange = useCallback(async (value: boolean) => {
    const previousValue = runUltrafix;
    setRunUltrafix(value);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { runUltrafix: value });
      setRunUltrafix(saved.runUltrafix);
      setUltrafixGoal(saved.ultrafixGoal);
      setUltrafixMaxCycles(saved.ultrafixMaxCycles);
    } catch (err) {
      setRunUltrafix(previousValue);
      addToast({ type: 'error', message: (err as Error).message || 'Failed to save ultrafix setting', duration: 5000 });
    }
  }, [addToast, draft.draft_id, runUltrafix]);

  const handleUltrafixGoalChange = useCallback(async (value: number | null) => {
    const previousValue = ultrafixGoal;
    setUltrafixGoal(value);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { ultrafixGoal: value });
      setUltrafixGoal(saved.ultrafixGoal);
    } catch (err) {
      setUltrafixGoal(previousValue);
      addToast({ type: 'error', message: (err as Error).message || 'Failed to save ultrafix goal', duration: 5000 });
    }
  }, [addToast, draft.draft_id, ultrafixGoal]);

  const handleUltrafixMaxCyclesChange = useCallback(async (value: number | null) => {
    const previousValue = ultrafixMaxCycles;
    setUltrafixMaxCycles(value);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { ultrafixMaxCycles: value });
      setUltrafixMaxCycles(saved.ultrafixMaxCycles);
    } catch (err) {
      setUltrafixMaxCycles(previousValue);
      addToast({ type: 'error', message: (err as Error).message || 'Failed to save ultrafix max cycles', duration: 5000 });
    }
  }, [addToast, draft.draft_id, ultrafixMaxCycles]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full bg-white overflow-hidden flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-3 border-b border-gray-200 bg-gray-100 flex-shrink-0 gap-2 sm:gap-4">
        <PlanHeaderSummary planName={planName} draftStatus={draft.status} isPaused={isPaused} repository={repository} baseBranch={baseBranch} initialPrompt={draft.initial_prompt} />
        <PlanHeaderActions draftStatus={draft.status} isPaused={isPaused} isPauseLoading={isPauseLoading} isRevising={isRevising} isDeleting={isDeleting} repoUrl={repoUrl} onPauseResume={handlePauseResume} onRevise={() => setShowReviseDialog(true)} onDelete={() => setShowDeleteDialog(true)} />
      </div>
      <div className="flex-1 overflow-auto p-4">
        <PlanIssuesManager draftId={draft.draft_id} tasks={tasks} onRefresh={onRefetch} onIssuesChange={handleIssuesChange} refreshKey={refreshKey} useEpic={useEpic} autoMerge={autoMerge} onUseEpicChange={handleUseEpicChange} onAutoMergeChange={handleAutoMergeChange} runUltrafix={runUltrafix} ultrafixGoal={ultrafixGoal} ultrafixMaxCycles={ultrafixMaxCycles} onRunUltrafixChange={handleRunUltrafixChange} onUltrafixGoalChange={handleUltrafixGoalChange} onUltrafixMaxCyclesChange={handleUltrafixMaxCyclesChange} draftStatus={draft.status} onCreationComplete={handleCreationComplete} />
      </div>
      <PlanFooterStats stats={footerStats} onRefresh={handleRefresh} />

      <DeletePlanDialog isOpen={showDeleteDialog} onClose={() => setShowDeleteDialog(false)} onConfirm={handleDeletePlanConfirm} isLoading={isDeleting} />
      <RevisePlanDialog isOpen={showReviseDialog} onClose={() => setShowReviseDialog(false)} onConfirm={handleRevisePlanConfirm} isLoading={isRevising} />
    </motion.div>
  );
};

export default ApprovedPlanView;
