import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, Github, GitMerge, FileQuestion, GitBranch, X, Loader2, Edit3, Pause, Play } from 'lucide-react';
import { StudioPhaseSwitcher } from './StudioStepper';
import { StudioScopePill } from './StudioScopePill';
import { PlanOverflowMenu, type PlanMenuItem } from './PlanEditorComponents';
import { useIsMobile } from '../../hooks/useIsMobile';

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
const PlanStatusBadges: React.FC<{ draftStatus: string; isPaused: boolean; iconOnly?: boolean }> = ({ draftStatus, isPaused, iconOnly = false }) => (
  <>
    {draftStatus === 'merged' && (
      <span className="px-2 py-1 rounded text-xs font-medium bg-slate-100 text-slate-600 flex items-center gap-1 flex-shrink-0" title="Merged">
        <GitMerge size={12} />{!iconOnly && <span>Merged</span>}
      </span>
    )}
    {isPaused && (
      <span className="px-2 py-1 rounded text-xs font-medium bg-orange-100 text-orange-700 flex items-center gap-1 flex-shrink-0" title="Paused">
        <Pause size={12} />{!iconOnly && <span>Paused</span>}
      </span>
    )}
  </>
);

const isPauseResumeAvailable = (draftStatus: string) => draftStatus === 'executed' || draftStatus === 'pr_created';

const HEADER_GHOST_BUTTON_CLASS = 'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** Desktop: Pause/Revise as quiet ghost buttons, a compact GitHub link, and Delete behind "…" so the title keeps its room. */
const PlanHeaderActions: React.FC<PlanHeaderActionsProps> = ({ draftStatus, isPaused, isPauseLoading, isRevising, isDeleting, repoUrl, onPauseResume, onRevise, onDelete, isReadOnly = false, isCreatingIssues = false }) => {
  const showPauseResume = isPauseResumeAvailable(draftStatus);
  return (
    <div className="ml-auto flex flex-shrink-0 items-center justify-end gap-1">
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
  // No min-w-0: the summary never shrinks below its content, so a header too narrow for both clusters
  // wraps the actions onto their own line instead of letting the summary slide underneath them.
  <div className="flex items-center gap-x-4 flex-1">
    {/* Compact repository chip anchors the git context without a full breadcrumb row; owner and branch are in the tooltip. */}
    {repository && (
      <span
        data-testid="plan-repo-chip"
        className="inline-flex max-w-[140px] flex-shrink-0 items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-700"
        title={`${repository} / ${baseBranch}`}
      >
        <GitBranch size={12} className="flex-shrink-0 text-slate-500" />
        <span className="truncate">{repository.split('/').pop() || repository}</span>
      </span>
    )}
    {/* The title grows into free header space (wider on widescreens) and keeps a readable floor; below
        it the actions wrap to a second line rather than squeezing the title away. Inline-size containment
        keeps the full title text out of the summary's minimum width, so only the floor counts. */}
    <h1 className="text-lg font-semibold text-gray-900 truncate flex-1 min-w-[12rem] max-w-xl 2xl:max-w-3xl [contain:inline-size]" title={planName}>
      {planName}
    </h1>
    <PlanStatusBadges draftStatus={draftStatus} isPaused={isPaused} />
    {/* Clusters are separated by the row's flex gap alone; no drawn or typed dividers between them. */}
    {initialPrompt && (
      <div className="hidden lg:block"><OriginalPromptPopover prompt={initialPrompt} /></div>
    )}
    <StudioPhaseSwitcher />
  </div>
);

type ApprovedPlanHeaderProps = PlanHeaderSummaryProps & Omit<PlanHeaderActionsProps, 'isPaused' | 'draftStatus'>;

/** Phone header menu: Pause/Resume and Revise join Delete behind "…", leaving the title row to the title. */
function buildMobileMenuItems({ draftStatus, isPaused, isPauseLoading, isRevising, isReadOnly = false, isCreatingIssues = false, onPauseResume, onRevise }: ApprovedPlanHeaderProps): PlanMenuItem[] {
  const items: PlanMenuItem[] = [];
  if (isPauseResumeAvailable(draftStatus)) {
    items.push({
      label: isPaused ? 'Resume' : 'Pause',
      icon: isPaused ? <Play size={14} /> : <Pause size={14} />,
      onSelect: onPauseResume,
      disabled: isPauseLoading || isReadOnly,
      title: isReadOnly ? 'Demo mode is read-only' : isPaused ? 'Resume plan execution' : 'Pause plan execution',
    });
  }
  items.push({
    label: 'Revise',
    icon: <Edit3 size={14} />,
    onSelect: onRevise,
    disabled: isRevising || isReadOnly || isCreatingIssues,
    title: isReadOnly ? 'Demo mode is read-only' : isCreatingIssues ? 'Revise is unavailable while issues are being created on GitHub' : 'Revise Plan',
  });
  return items;
}

/**
 * Phone header in two tiers: the `propr/main` scope pill with the step badge, then the plan title
 * on its own line with a compact GitHub link and the "…" menu.
 */
const MobilePlanHeader: React.FC<ApprovedPlanHeaderProps> = (props) => {
  const { planName, draftStatus, isPaused, repository, baseBranch, repoUrl, isDeleting, isReadOnly = false, onDelete } = props;
  return (
    <div data-testid="approved-plan-mobile-header" className="flex flex-col gap-1.5 border-b border-gray-200 bg-gray-100 px-4 py-2 flex-shrink-0">
      <div className="flex items-center gap-2">
        {repository && <StudioScopePill repository={repository} baseBranch={baseBranch} />}
        <PlanStatusBadges draftStatus={draftStatus} isPaused={isPaused} iconOnly />
        <StudioPhaseSwitcher className="ml-auto" />
      </div>
      <div className="flex items-center gap-1">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900" title={planName}>{planName}</h1>
        {repoUrl && (
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View issues on GitHub"
            title="View issues on GitHub"
            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors"
          >
            <Github size={15} />
            <ExternalLink size={12} className="text-slate-400" />
          </a>
        )}
        <PlanOverflowMenu
          isDeleting={isDeleting}
          deleteDisabled={isDeleting || isReadOnly}
          deleteTitle={isReadOnly ? 'Demo mode is read-only' : 'Delete Plan'}
          onDelete={onDelete}
          items={buildMobileMenuItems(props)}
        />
      </div>
    </div>
  );
};

export const ApprovedPlanHeader: React.FC<ApprovedPlanHeaderProps> = (props) => {
  const isMobile = useIsMobile(768);
  if (isMobile) return <MobilePlanHeader {...props} />;
  const { planName, draftStatus, isPaused, repository, baseBranch, initialPrompt, ...actions } = props;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-gray-200 bg-gray-100 px-6 py-2 flex-shrink-0">
      <PlanHeaderSummary planName={planName} draftStatus={draftStatus} isPaused={isPaused} repository={repository} baseBranch={baseBranch} initialPrompt={initialPrompt} />
      <PlanHeaderActions draftStatus={draftStatus} isPaused={isPaused} {...actions} />
    </div>
  );
};
