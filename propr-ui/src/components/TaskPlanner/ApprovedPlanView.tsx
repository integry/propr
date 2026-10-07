import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { DraftWithPlan, deleteDraft } from '../../api/proprApi';
import DeletePlanDialog from './DeletePlanDialog';
import RevisePlanDialog from './RevisePlanDialog';
import PlanIssuesManager from './PlanIssuesManager';
import { getDraftDisplayName } from './planDisplayName';
import { ApprovedPlanHeader } from './ApprovedPlanHeader';
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
      <ApprovedPlanHeader planName={planName} draftStatus={draft.status} isPaused={isPaused} repository={repository} baseBranch={baseBranch} initialPrompt={draft.initial_prompt} isPauseLoading={isPauseLoading} isRevising={isRevising} isDeleting={isDeleting} repoUrl={repoUrl} onPauseResume={handlePauseResume} onRevise={() => { if (!isDemoMode && !isCreatingIssues) setShowReviseDialog(true); }} onDelete={() => { if (!isDemoMode) setShowDeleteDialog(true); }} isReadOnly={isDemoMode} isCreatingIssues={isCreatingIssues} />
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
