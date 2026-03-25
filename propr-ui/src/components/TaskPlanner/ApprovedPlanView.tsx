import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, Github, GitMerge, FileQuestion, GitBranch, X, RefreshCw, Trash2, Loader2, Edit3, Pause, Play } from 'lucide-react';
import { DraftWithPlan, deleteDraft } from '../../api/proprApi';
import DeletePlanDialog from './DeletePlanDialog';
import RevisePlanDialog from './RevisePlanDialog';
import PlanIssuesManager from './PlanIssuesManager';
import { PlanTask, reviseDraft, pauseDraft, resumeDraft } from '../../api/plannerApi';
import { PlanIssue } from '../../api/planIssuesApi';
import { useToast } from '../ui/useToast';

interface ApprovedPlanViewProps {
  draft: DraftWithPlan;
  onRefetch?: () => void;
}

// Original Prompt Popover Component - styled like Step 2 (Review Plan)
interface OriginalPromptPopoverProps {
  prompt: string;
}

const OriginalPromptPopover: React.FC<OriginalPromptPopoverProps> = ({ prompt }) => {
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
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setIsOpen(false)}
            />
            {/* Popover */}
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="absolute top-full left-0 mt-2 z-50 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden"
            >
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Original Prompt</span>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1 hover:bg-gray-200 rounded transition-colors"
                >
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

// Footer stats display component
interface FooterStats {
  total: number;
  merged: number;
  underReview: number;
  pending: number;
  processing: number;
}

interface PlanFooterStatsProps {
  stats: FooterStats;
  onRefresh: () => void;
}

const PlanFooterStats: React.FC<PlanFooterStatsProps> = ({ stats, onRefresh }) => (
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

// Header actions component (pause/resume, revise, delete, github link)
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


export const ApprovedPlanView: React.FC<ApprovedPlanViewProps> = ({ draft, onRefetch }) => {
  const navigate = useNavigate();
  const { addToast } = useToast();

  // State to hold issues data for footer stats
  const [issues, setIssues] = useState<PlanIssue[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showReviseDialog, setShowReviseDialog] = useState(false);
  const [isRevising, setIsRevising] = useState(false);
  const [isPaused, setIsPaused] = useState(draft.paused || false);
  const [isPauseLoading, setIsPauseLoading] = useState(false);

  // Epic PR options state
  const [useEpic, setUseEpic] = useState(false);
  const [autoMerge, setAutoMerge] = useState(false);

  // Plan name: prefer draft.name, fall back to initial_prompt
  const planName = draft.name || draft.initial_prompt || 'Untitled Plan';

  // Handle delete plan confirmation
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

  // Handle pause/resume toggle
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

  // Handle revise plan confirmation
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

  // Defensively ensure plan_json is an array
  const tasks: PlanTask[] = useMemo(() => {
    let planJson = draft.plan_json;
    if (typeof planJson === 'string') {
      try { planJson = JSON.parse(planJson); } catch { return []; }
    }
    return Array.isArray(planJson) ? planJson : [];
  }, [draft.plan_json]);

  // Extract repository URL from draft
  const repoUrl = draft.repository ? `https://github.com/${draft.repository}/issues` : null;

  // Extract repository and branch info
  const repository = draft.repository || '';
  const baseBranch = draft.context_config?.baseBranch || 'main';

  // Callback to receive issues from PlanIssuesManager
  const handleIssuesChange = useCallback((updatedIssues: PlanIssue[]) => {
    setIssues(updatedIssues);
  }, []);

  // Compute footer stats from issues (actual data, not tasks)
  const footerStats = useMemo(() => {
    const total = issues.length;
    const merged = issues.filter(i => i.status === 'merged').length;
    const underReview = issues.filter(i => i.status === 'pr_open' || i.status === 'pr_review').length;
    const pending = issues.filter(i => i.status === 'pending').length;
    const processing = issues.filter(i => i.status === 'processing' || i.status === 'refinement_processing').length;
    return { total, merged, underReview, pending, processing };
  }, [issues]);

  // Handle refresh from footer
  const handleRefresh = useCallback(() => {
    setRefreshKey(prev => prev + 1);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-full bg-white overflow-hidden flex flex-col"
    >
      {/* Pro Studio Header - Anchored with gray background */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-3 border-b border-gray-200 bg-gray-100 flex-shrink-0 gap-2 sm:gap-4">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
          <h1 className="text-base sm:text-lg font-semibold text-gray-900 truncate min-w-0 flex-shrink" title={planName}>
            {planName}
          </h1>
          {draft.status === 'merged' && (
            <span className="px-2 py-1 rounded text-xs font-medium bg-purple-100 text-purple-700 flex items-center gap-1 flex-shrink-0">
              <GitMerge size={12} />
              <span className="hidden sm:inline">Merged</span>
            </span>
          )}
          {isPaused && (
            <span className="px-2 py-1 rounded text-xs font-medium bg-orange-100 text-orange-700 flex items-center gap-1 flex-shrink-0">
              <Pause size={12} />
              <span className="hidden sm:inline">Paused</span>
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
          {draft.initial_prompt && (
            <>
              <div className="h-4 w-px bg-gray-300 flex-shrink-0 hidden lg:block" />
              <div className="hidden lg:block">
                <OriginalPromptPopover prompt={draft.initial_prompt} />
              </div>
            </>
          )}
        </div>

        <PlanHeaderActions
          draftStatus={draft.status}
          isPaused={isPaused}
          isPauseLoading={isPauseLoading}
          isRevising={isRevising}
          isDeleting={isDeleting}
          repoUrl={repoUrl}
          onPauseResume={handlePauseResume}
          onRevise={() => setShowReviseDialog(true)}
          onDelete={() => setShowDeleteDialog(true)}
        />
      </div>

      {/* Single-Pane Action Dashboard */}
      <div className="flex-1 overflow-auto p-4">
        <PlanIssuesManager
          draftId={draft.draft_id}
          tasks={tasks}
          onIssuesChange={handleIssuesChange}
          refreshKey={refreshKey}
          useEpic={useEpic}
          autoMerge={autoMerge}
          onUseEpicChange={setUseEpic}
          onAutoMergeChange={setAutoMerge}
        />
      </div>

      <PlanFooterStats stats={footerStats} onRefresh={handleRefresh} />

      <DeletePlanDialog
        isOpen={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={handleDeletePlanConfirm}
        isLoading={isDeleting}
      />

      <RevisePlanDialog
        isOpen={showReviseDialog}
        onClose={() => setShowReviseDialog(false)}
        onConfirm={handleRevisePlanConfirm}
        isLoading={isRevising}
      />
    </motion.div>
  );
};

export default ApprovedPlanView;
