import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, Github, GitMerge, FileQuestion, GitBranch, X, RefreshCw, Trash2, Loader2, Layers, ArrowDownToLine } from 'lucide-react';
import { DraftWithPlan, deleteDraft } from '../../api/gitfixApi';
import DeletePlanDialog from './DeletePlanDialog';
import PlanIssuesManager from './PlanIssuesManager';
import { PlanTask } from '../../api/plannerApi';
import { PlanIssue } from '../../api/planIssuesApi';
import { useToast } from '../ui/useToast';

interface ApprovedPlanViewProps {
  draft: DraftWithPlan;
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


export const ApprovedPlanView: React.FC<ApprovedPlanViewProps> = ({ draft }) => {
  const navigate = useNavigate();
  const { addToast } = useToast();

  // State to hold issues data for footer stats
  const [issues, setIssues] = useState<PlanIssue[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Epic PR options state
  const [useEpic, setUseEpic] = useState(false);
  const [autoMerge, setAutoMerge] = useState(false);

  // Handle useEpic toggle - reset autoMerge when Epic is disabled
  const handleUseEpicChange = (checked: boolean) => {
    setUseEpic(checked);
    if (!checked) {
      setAutoMerge(false);
    }
  };

  // Plan name: prefer draft.name, fall back to initial_prompt
  const planName = draft.name || draft.initial_prompt || 'Untitled Plan';

  // Handle delete plan confirmation
  const handleDeletePlanConfirm = async () => {
    setIsDeleting(true);
    try {
      await deleteDraft(draft.draft_id);
      setShowDeleteDialog(false);
      addToast({
        type: 'success',
        message: 'Plan deleted successfully',
        duration: 3000
      });
      navigate('/plans');
    } catch (err) {
      addToast({
        type: 'error',
        message: (err as Error).message || 'Failed to delete plan',
        duration: 5000
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Defensively ensure plan_json is an array
  const tasks: PlanTask[] = (() => {
    let planJson = draft.plan_json;
    if (typeof planJson === 'string') {
      try { planJson = JSON.parse(planJson); } catch { return []; }
    }
    return Array.isArray(planJson) ? planJson : [];
  })();

  // Extract repository URL from draft
  const getRepositoryUrl = () => {
    const repo = draft.repository;
    if (!repo) return null;
    return `https://github.com/${repo}/issues`;
  };

  const repoUrl = getRepositoryUrl();

  // Extract repository and branch info
  const repository = draft.repository || '';
  const baseBranch = draft.context_config?.baseBranch || 'main';

  // Callback to receive issues from PlanIssuesManager
  const handleIssuesChange = (updatedIssues: PlanIssue[]) => {
    setIssues(updatedIssues);
  };

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
  const handleRefresh = () => {
    setRefreshKey(prev => prev + 1);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-full bg-white overflow-hidden flex flex-col"
    >
      {/* Pro Studio Header - Anchored with gray background */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-gray-100 flex-shrink-0 gap-4">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          {/* Plan Name - responsive width based on available space */}
          <h1 className="text-lg font-semibold text-gray-900 truncate min-w-0 flex-shrink" title={planName}>
            {planName}
          </h1>
          <div className="h-4 w-px bg-gray-300 flex-shrink-0" />
          {/* Repository and Branch Breadcrumb */}
          <div className="flex items-center gap-2 text-sm flex-shrink-0">
            <Github size={16} className="text-gray-500" />
            <span className="font-medium text-gray-900 truncate max-w-[200px]" title={repository}>{repository}</span>
            <span className="text-gray-400">/</span>
            <GitBranch size={14} className="text-gray-500" />
            <span className="text-gray-600">{baseBranch}</span>
          </div>
          {/* Original Prompt - styled like Step 2 (Review Plan) */}
          {draft.initial_prompt && (
            <>
              <div className="h-4 w-px bg-gray-300 flex-shrink-0 hidden lg:block" />
              <div className="hidden lg:block">
                <OriginalPromptPopover prompt={draft.initial_prompt} />
              </div>
            </>
          )}
          {draft.status === 'merged' && (
            <>
              <div className="h-4 w-px bg-gray-300 flex-shrink-0" />
              <span className="px-2 py-1 rounded text-xs font-medium bg-purple-100 text-purple-700 flex items-center gap-1">
                <GitMerge size={12} />
                Merged
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Delete Plan */}
          <button
            onClick={() => setShowDeleteDialog(true)}
            disabled={isDeleting}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Delete Plan"
          >
            {isDeleting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Trash2 size={16} />
            )}
          </button>
          {repoUrl && (
            <>
              <div className="h-6 w-px bg-gray-300 mx-1" />
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors text-sm"
              >
                <Github size={16} />
                View Issues on GitHub
                <ExternalLink size={14} />
              </a>
            </>
          )}
        </div>
      </div>

      {/* Single-Pane Action Dashboard */}
      <div className="flex-1 overflow-auto p-4">
        <PlanIssuesManager
          draftId={draft.draft_id}
          tasks={tasks}
          repository={draft.repository}
          onIssuesChange={handleIssuesChange}
          refreshKey={refreshKey}
          useEpic={useEpic}
          autoMerge={autoMerge}
        />
      </div>

      {/* Pro Studio Footer - Anchored with status summary and refresh */}
      <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-100 flex-shrink-0">
        <div className="flex items-center gap-1 text-sm text-gray-600">
          <span className="font-medium">{footerStats.total} {footerStats.total === 1 ? 'Issue' : 'Issues'} Total</span>
          {footerStats.merged > 0 && (
            <>
              <span className="text-gray-400 mx-1">•</span>
              <span className="text-purple-600">{footerStats.merged} Merged</span>
            </>
          )}
          {footerStats.underReview > 0 && (
            <>
              <span className="text-gray-400 mx-1">•</span>
              <span className="text-blue-600">{footerStats.underReview} Review</span>
            </>
          )}
          {footerStats.processing > 0 && (
            <>
              <span className="text-gray-400 mx-1">•</span>
              <span className="text-amber-600">{footerStats.processing} Processing</span>
            </>
          )}
          {footerStats.pending > 0 && (
            <>
              <span className="text-gray-400 mx-1">•</span>
              <span className="text-gray-500">{footerStats.pending} Pending</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-4">
          {/* Epic PR Options */}
          <div className="flex items-center gap-4 border-r border-gray-300 pr-4">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useEpic}
                onChange={(e) => handleUseEpicChange(e.target.checked)}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
              />
              <Layers size={14} className="text-gray-500" />
              <span>Create Epic PR</span>
            </label>
            <label className={`flex items-center gap-2 text-sm cursor-pointer select-none ${useEpic ? 'text-gray-700' : 'text-gray-400 cursor-not-allowed'}`}>
              <input
                type="checkbox"
                checked={autoMerge}
                onChange={(e) => setAutoMerge(e.target.checked)}
                disabled={!useEpic}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              />
              <ArrowDownToLine size={14} className={useEpic ? 'text-gray-500' : 'text-gray-300'} />
              <span>Auto-merge to Epic</span>
            </label>
          </div>
          <button
            onClick={handleRefresh}
            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors"
            title="Refresh issues"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <DeletePlanDialog
        isOpen={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        onConfirm={handleDeletePlanConfirm}
        isLoading={isDeleting}
      />
    </motion.div>
  );
};

export default ApprovedPlanView;
