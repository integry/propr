import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, Github, GitMerge, FileQuestion, GitBranch, X, Loader2, Edit3, Pause, Play } from 'lucide-react';
import { DraftWithPlan, deleteDraft } from '../../api/proprApi';
import DeletePlanDialog from './DeletePlanDialog';
import RevisePlanDialog from './RevisePlanDialog';
import PlanIssuesManager from './PlanIssuesManager';
import { getDraftDisplayName } from './planDisplayName';
import { StudioPhaseSwitcher } from './StudioStepper';
import { PlanOverflowMenu } from './PlanEditorComponents';
import { PlanTask, reviseDraft, pauseDraft, resumeDraft, updateExecutionSettings } from '../../api/plannerApi';
import { PlanIssue } from '../../api/planIssuesApi';
import { PlanFooterStats } from './ApprovedPlanFooter';
import { buildFooterStats, buildCreationFooterStats } from './approvedPlanFooterStats';
import { IDLE_PROGRESS, type IssueCreationProgress } from './planIssuesManagerUtils';
import { useToast } from '../ui/useToast';
import { useDemoMode } from '../../contexts/DemoModeContext';
import type { PlanNotificationIntent } from '../../utils/notificationIntents';

interface ApprovedPlanViewProps {
  draft: DraftWithPlan;
  onRefetch?: () => void;
  notificationIntent?: PlanNotificationIntent | null;
  onNotificationIntentConsumed?: () => void;
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
  isReadOnly?: boolean;
  /** Issues are being written to GitHub; revising now would race the run and orphan issues. */
  isCreatingIssues?: boolean;
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

async function persistExecutionSetting(draftId: string, update: Parameters<typeof updateExecutionSettings>[1]): Promise<Awaited<ReturnType<typeof updateExecutionSettings>>> {
  return updateExecutionSettings(draftId, update);
}

const HEADER_GHOST_BUTTON_CLASS = 'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** Pause/Revise as quiet ghost buttons, a compact GitHub link, and Delete behind "…" so the title keeps its room. */
const PlanHeaderActions: React.FC<PlanHeaderActionsProps> = ({ draftStatus, isPaused, isPauseLoading, isRevising, isDeleting, repoUrl, onPauseResume, onRevise, onDelete, isReadOnly = false, isCreatingIssues = false }) => {
  const showPauseResume = draftStatus === 'executed' || draftStatus === 'pr_created';
  return (
    <div className="flex w-full flex-wrap items-center gap-1 md:w-auto md:flex-shrink-0 md:flex-nowrap md:justify-end">
      {showPauseResume && (
        <button
          onClick={onPauseResume}
          disabled={isPauseLoading || isReadOnly}
          className={HEADER_GHOST_BUTTON_CLASS}
          title={isReadOnly ? 'Demo mode is read-only' : isPaused ? 'Resume plan execution' : 'Pause plan execution'}
        >
          {isPauseLoading ? (
            <Loader2 size={15} className="animate-spin" />
          ) : isPaused ? (
            <Play size={15} />
          ) : (
            <Pause size={15} />
          )}
          <span>{isPaused ? 'Resume' : 'Pause'}</span>
        </button>
      )}
      <button
        onClick={onRevise}
        disabled={isRevising || isReadOnly || isCreatingIssues}
        className={HEADER_GHOST_BUTTON_CLASS}
        title={isReadOnly ? 'Demo mode is read-only' : isCreatingIssues ? 'Revise is unavailable while issues are being created on GitHub' : 'Revise Plan'}
      >
        {isRevising ? <Loader2 size={15} className="animate-spin" /> : <Edit3 size={15} />}
        <span>Revise</span>
      </button>
      {repoUrl && (
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View issues on GitHub"
          title="View issues on GitHub"
          className="ml-1 flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors"
        >
          <Github size={15} />
          <span>GitHub</span>
          <ExternalLink size={12} className="text-slate-400" />
        </a>
      )}
      <PlanOverflowMenu
        isDeleting={isDeleting}
        deleteDisabled={isDeleting || isReadOnly}
        deleteTitle={isReadOnly ? 'Demo mode is read-only' : 'Delete Plan'}
        onDelete={onDelete}
      />
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
const PlanHeaderSummary: React.FC<PlanHeaderSummaryProps> = ({ planName, draftStatus, isPaused, repository, baseBranch, initialPrompt }) => (
  // Phones stack the title under the repo chip and phase pill so it gets the full width; md+ keeps one row.
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4 min-w-0 flex-1 md:flex-nowrap">
    {/* Compact repository chip anchors the git context without a full breadcrumb row; owner and branch are in the tooltip. */}
    {repository && (
      <span
        data-testid="plan-repo-chip"
        className="inline-flex max-w-[96px] sm:max-w-[140px] flex-shrink-0 items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-700"
        title={`${repository} / ${baseBranch}`}
      >
        <GitBranch size={12} className="flex-shrink-0 text-slate-500" />
        <span className="truncate">{repository.split('/').pop() || repository}</span>
      </span>
    )}
    {/* The title grows into free header space (wider on widescreens) and keeps at least 320px before the controls squeeze it. */}
    <h1 className="order-last w-full text-base sm:text-lg font-semibold text-gray-900 truncate min-w-0 md:order-none md:w-auto md:flex-1 md:min-w-[320px] md:max-w-xl 2xl:max-w-3xl" title={planName}>
      {planName}
    </h1>
    {draftStatus === 'merged' && (
      <span className="px-2 py-1 rounded text-xs font-medium bg-slate-100 text-slate-600 flex items-center gap-1 flex-shrink-0">
        <GitMerge size={12} /><span className="hidden sm:inline">Merged</span>
      </span>
    )}
    {isPaused && (
      <span className="px-2 py-1 rounded text-xs font-medium bg-orange-100 text-orange-700 flex items-center gap-1 flex-shrink-0">
        <Pause size={12} /><span className="hidden sm:inline">Paused</span>
      </span>
    )}
    {/* Clusters are separated by the row's flex gap alone; no drawn or typed dividers between them. */}
    {initialPrompt && (
      <div className="hidden lg:block"><OriginalPromptPopover prompt={initialPrompt} /></div>
    )}
    {/* The phase pill replaces the old stepper band on phones too, so it shares the title row. */}
    <StudioPhaseSwitcher className="ml-auto md:ml-0" />
  </div>
);

export const ApprovedPlanView: React.FC<ApprovedPlanViewProps> = ({
  draft,
  onRefetch,
  notificationIntent = null,
  onNotificationIntentConsumed,
}) => {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const { isDemoMode } = useDemoMode();
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
  const [pendingExecutionSettingsSaves, setPendingExecutionSettingsSaves] = useState(0);
  const isSavingExecutionSettings = pendingExecutionSettingsSaves > 0;

  const planName = getDraftDisplayName(draft, 'Untitled Plan');
  const repository = draft.repository || '';
  const baseBranch = draft.context_config?.baseBranch || 'main';
  const repoUrl = draft.repository ? `https://github.com/${draft.repository}/issues` : null;
  const tasks: PlanTask[] = useMemo(() => parsePlanTasks(draft.plan_json), [draft.plan_json]);
  const footerStats = useMemo(() => buildFooterStats(issues), [issues]);
  const [creationProgress, setCreationProgress] = useState<IssueCreationProgress>(IDLE_PROGRESS);
  const isCreatingIssues = draft.status === 'executing' || creationProgress.status === 'in_progress';
  const creationStats = useMemo(
    () => (isCreatingIssues ? buildCreationFooterStats(creationProgress, tasks.length) : null),
    [creationProgress, isCreatingIssues, tasks.length],
  );

  const handleDeletePlanConfirm = useCallback(async () => {
    if (isDemoMode) {
      addToast({ type: 'warning', message: 'Demo mode is read-only.', duration: 3000 });
      return;
    }
    setIsDeleting(true);
    try {
      await deleteDraft(draft.draft_id);
      setShowDeleteDialog(false);
      addToast({ type: 'success', message: 'Plan deleted successfully', duration: 3000 });
      navigate('/plans');
    } catch (err) { addToast({ type: 'error', message: (err as Error).message || 'Failed to delete plan', duration: 5000 }); } finally { setIsDeleting(false); }
  }, [addToast, draft.draft_id, isDemoMode, navigate]);

  const handlePauseResume = useCallback(async () => {
    if (isDemoMode) {
      addToast({ type: 'warning', message: 'Demo mode is read-only.', duration: 3000 });
      return;
    }
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
    } catch (err) { addToast({ type: 'error', message: (err as Error).message || `Failed to ${isPaused ? 'resume' : 'pause'} plan`, duration: 5000 }); } finally { setIsPauseLoading(false); }
  }, [addToast, draft.draft_id, isDemoMode, isPaused]);

  const handleRevisePlanConfirm = useCallback(async () => {
    if (isDemoMode) {
      addToast({ type: 'warning', message: 'Demo mode is read-only.', duration: 3000 });
      return;
    }
    setIsRevising(true);
    try {
      const result = await reviseDraft(draft.draft_id);
      setShowReviseDialog(false);
      const message = result.issuesDetached > 0
        ? `Plan revised successfully. ${result.issuesDetached} issue(s) detached.`
        : 'Plan revised successfully.';
      addToast({ type: 'success', message, duration: 3000 });
      onRefetch?.();
    } catch (err) { addToast({ type: 'error', message: (err as Error).message || 'Failed to revise plan', duration: 5000 }); } finally { setIsRevising(false); }
  }, [addToast, draft.draft_id, isDemoMode, onRefetch]);

  const handleRefresh = useCallback(() => setRefreshKey(prev => prev + 1), []);
  const handleIssuesChange = useCallback((newIssues: PlanIssue[]) => _setIssues(newIssues), []);

  const handleCreationComplete = useCallback((createdCount: number, failedCount: number) => {
    addToast(failedCount > 0
      ? { type: 'warning', message: `Created ${createdCount} issue${createdCount !== 1 ? 's' : ''}, ${failedCount} failed`, duration: 5000 }
      : { type: 'success', message: `Successfully created ${createdCount} GitHub issue${createdCount !== 1 ? 's' : ''}`, duration: 4000 });
  }, [addToast]);

  const handleUseEpicChange = useCallback(async (value: boolean) => {
    if (isDemoMode) return;
    const previousValue = useEpic;
    setUseEpic(value);
    setPendingExecutionSettingsSaves((count) => count + 1);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { useEpic: value });
      setUseEpic(saved.useEpic);
    } catch (err) { setUseEpic(previousValue); addToast({ type: 'error', message: (err as Error).message || 'Failed to save Epic PR setting', duration: 5000 }); }
    finally { setPendingExecutionSettingsSaves((count) => Math.max(0, count - 1)); }
  }, [addToast, draft.draft_id, isDemoMode, useEpic]);

  const handleAutoMergeChange = useCallback(async (value: boolean) => {
    if (isDemoMode) return;
    const previousValue = autoMerge;
    setAutoMerge(value);
    setPendingExecutionSettingsSaves((count) => count + 1);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { autoMerge: value });
      setAutoMerge(saved.autoMerge);
    } catch (err) { setAutoMerge(previousValue); addToast({ type: 'error', message: (err as Error).message || 'Failed to save auto-merge setting', duration: 5000 }); }
    finally { setPendingExecutionSettingsSaves((count) => Math.max(0, count - 1)); }
  }, [addToast, autoMerge, draft.draft_id, isDemoMode]);

  const handleRunUltrafixChange = useCallback(async (value: boolean) => {
    if (isDemoMode) return;
    const previousValue = runUltrafix;
    setRunUltrafix(value);
    setPendingExecutionSettingsSaves((count) => count + 1);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { runUltrafix: value });
      setRunUltrafix(saved.runUltrafix);
      setUltrafixGoal(saved.ultrafixGoal);
      setUltrafixMaxCycles(saved.ultrafixMaxCycles);
    } catch (err) { setRunUltrafix(previousValue); addToast({ type: 'error', message: (err as Error).message || 'Failed to save ultrafix setting', duration: 5000 }); }
    finally { setPendingExecutionSettingsSaves((count) => Math.max(0, count - 1)); }
  }, [addToast, draft.draft_id, isDemoMode, runUltrafix]);

  const handleUltrafixGoalChange = useCallback(async (value: number | null) => {
    if (isDemoMode) return;
    const previousValue = ultrafixGoal;
    setUltrafixGoal(value);
    setPendingExecutionSettingsSaves((count) => count + 1);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { ultrafixGoal: value });
      setUltrafixGoal(saved.ultrafixGoal);
    } catch (err) { setUltrafixGoal(previousValue); addToast({ type: 'error', message: (err as Error).message || 'Failed to save ultrafix goal', duration: 5000 }); }
    finally { setPendingExecutionSettingsSaves((count) => Math.max(0, count - 1)); }
  }, [addToast, draft.draft_id, isDemoMode, ultrafixGoal]);

  const handleUltrafixMaxCyclesChange = useCallback(async (value: number | null) => {
    if (isDemoMode) return;
    const previousValue = ultrafixMaxCycles;
    setUltrafixMaxCycles(value);
    setPendingExecutionSettingsSaves((count) => count + 1);
    try {
      const saved = await persistExecutionSetting(draft.draft_id, { ultrafixMaxCycles: value });
      setUltrafixMaxCycles(saved.ultrafixMaxCycles);
    } catch (err) { setUltrafixMaxCycles(previousValue); addToast({ type: 'error', message: (err as Error).message || 'Failed to save ultrafix max cycles', duration: 5000 }); }
    finally { setPendingExecutionSettingsSaves((count) => Math.max(0, count - 1)); }
  }, [addToast, draft.draft_id, isDemoMode, ultrafixMaxCycles]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full bg-white overflow-hidden flex flex-col">
      <div className="flex flex-col gap-2 border-b border-gray-200 bg-gray-100 px-4 py-2 flex-shrink-0 sm:px-6 md:flex-row md:items-center md:justify-between md:gap-4">
        <PlanHeaderSummary planName={planName} draftStatus={draft.status} isPaused={isPaused} repository={repository} baseBranch={baseBranch} initialPrompt={draft.initial_prompt} />
        <PlanHeaderActions draftStatus={draft.status} isPaused={isPaused} isPauseLoading={isPauseLoading} isRevising={isRevising} isDeleting={isDeleting} repoUrl={repoUrl} onPauseResume={handlePauseResume} onRevise={() => { if (!isDemoMode && !isCreatingIssues) setShowReviseDialog(true); }} onDelete={() => { if (!isDemoMode) setShowDeleteDialog(true); }} isReadOnly={isDemoMode} isCreatingIssues={isCreatingIssues} />
      </div>
      <div className="flex-1 overflow-auto p-4">
        <PlanIssuesManager draftId={draft.draft_id} repository={repository} tasks={tasks} onRefresh={onRefetch} onIssuesChange={handleIssuesChange} refreshKey={refreshKey} useEpic={useEpic} autoMerge={autoMerge} onUseEpicChange={handleUseEpicChange} onAutoMergeChange={handleAutoMergeChange} runUltrafix={runUltrafix} ultrafixGoal={ultrafixGoal} ultrafixMaxCycles={ultrafixMaxCycles} onRunUltrafixChange={handleRunUltrafixChange} onUltrafixGoalChange={handleUltrafixGoalChange} onUltrafixMaxCyclesChange={handleUltrafixMaxCyclesChange} draftStatus={draft.status} onCreationComplete={handleCreationComplete} onCreationProgressChange={setCreationProgress} isSavingExecutionSettings={isSavingExecutionSettings} isReadOnly={isDemoMode} notificationIntent={notificationIntent} onNotificationIntentConsumed={onNotificationIntentConsumed} />
      </div>
      <PlanFooterStats stats={footerStats} creation={creationStats} onRefresh={handleRefresh} />
      <DeletePlanDialog isOpen={showDeleteDialog} onClose={() => setShowDeleteDialog(false)} onConfirm={handleDeletePlanConfirm} isLoading={isDeleting} />
      <RevisePlanDialog isOpen={showReviseDialog} onClose={() => setShowReviseDialog(false)} onConfirm={handleRevisePlanConfirm} isLoading={isRevising} />
    </motion.div>
  );
};

export default ApprovedPlanView;
