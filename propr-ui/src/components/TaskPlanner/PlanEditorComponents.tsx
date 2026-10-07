import React, { useState } from 'react';
import { FileQuestion, Info, X, Undo2, Redo2, ArrowLeft, GitBranch, AlertCircle, History, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { GranularityEnforcementMetadata } from '../../api/proprApi';
import { StudioPhaseSwitcher } from './StudioStepper';
import { FinalizeButton } from './FinalizeButton';
import { PlanOverflowMenu } from './PlanOverflowMenu';
import { PlanEditorMobileHeader } from './PlanEditorMobileHeader';
import { getReadOnlyTitle, isPlanActionDisabled } from './planEditorHeaderUtils';

export { PlanOverflowMenu, type PlanMenuItem } from './PlanOverflowMenu';

interface OriginalPromptPopoverProps {
  prompt: string;
  buttonClassName?: string;
  labelClassName?: string;
}

const PROMPT_BUTTON_CLASS = 'flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-full transition-colors text-teal-700 hover:bg-teal-50';

export const OriginalPromptPopover: React.FC<OriginalPromptPopoverProps> = ({ prompt, buttonClassName = PROMPT_BUTTON_CLASS, labelClassName = 'hidden sm:inline' }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={buttonClassName}
        title="View original prompt"
        aria-label="Prompt"
      >
        <FileQuestion size={14} />
        <span className={`${labelClassName} font-medium`}>Prompt</span>
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

interface GranularityEnforcementNoticeProps {
  enforcement: GranularityEnforcementMetadata;
  onDismiss: () => void;
}

export const GranularityEnforcementNotice: React.FC<GranularityEnforcementNoticeProps> = ({ enforcement, onDismiss }) => {
  if (!enforcement.enforced) return null;

  return (
    <div className="px-4 py-2 bg-blue-50 border-b border-blue-200 text-blue-700 text-sm flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Info size={14} />
        <span>{enforcement.message || `${enforcement.originalTaskCount} tasks merged into ${enforcement.finalTaskCount} per your Single Task setting`}</span>
      </div>
      <button
        onClick={onDismiss}
        className="p-1 hover:bg-blue-100 rounded transition-colors"
        title="Dismiss"
        aria-label="Dismiss granularity enforcement notice"
      >
        <X size={14} />
      </button>
    </div>
  );
};

// Plan Editor Header Props
export interface PlanEditorHeaderProps {
  planName: string;
  repository: string;
  baseBranch: string;
  originalPrompt?: string;
  isDeleting: boolean;
  isFinalizing: boolean;
  isResettingToSetup: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onDelete: () => void;
  onBackToSetup: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onShowHistory?: () => void;
  isMobile?: boolean;
  isReadOnly?: boolean;
  /** Desktop only: whether the Assistant pane is shown, and the toggle for it. */
  isAssistantOpen?: boolean;
  onToggleAssistant?: () => void;
  /** Desktop only: the plan's primary action ("Create N GitHub Issues") sits in the header. */
  planLength?: number;
  onFinalize?: () => void;
}

const SECONDARY_GROUP_BUTTON_CLASS = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed first:rounded-l-md last:rounded-r-md';
const ICON_GROUP_BUTTON_CLASS = 'px-2 py-1.5 text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors first:rounded-l-md last:rounded-r-md';

const PlanEditorDesktopHeader: React.FC<PlanEditorHeaderProps> = ({
  planName,
  repository,
  baseBranch,
  originalPrompt,
  isDeleting,
  isFinalizing,
  isResettingToSetup,
  canUndo,
  canRedo,
  onDelete,
  onBackToSetup,
  onUndo,
  onRedo,
  onShowHistory,
  isReadOnly = false,
  isAssistantOpen,
  onToggleAssistant,
  planLength,
  onFinalize
}) => {
  const actionDisabled = isPlanActionDisabled(isFinalizing, isResettingToSetup, isDeleting, isReadOnly);

  const repoName = repository.split('/').pop() || repository;

  return (
    <div className="flex items-center justify-between px-6 py-2 border-b border-gray-200 bg-gray-100 flex-shrink-0 gap-6">
      {/* Only the plan name (and the branch chip) shrink; the phase pill keeps its width, so it
          can never slide under the tool cluster. min-w-0 lets the title truncate instead of widening the page. */}
      <div data-testid="plan-editor-title-group" className="flex items-center gap-3 min-w-0 flex-1">
        {/* Plan Name - takes the space the actions no longer need */}
        <h1 className="text-base font-semibold text-gray-900 truncate min-w-0 flex-1" title={planName}>
          {planName}
        </h1>
        {/* Repository and branch as quiet code metadata */}
        <div className="flex items-center gap-2 text-xs min-w-0 flex-shrink">
          <span className="hidden 2xl:inline font-mono text-slate-600 truncate max-w-[160px]" title={repository}>{repoName}</span>
          <span className="inline-flex min-w-0 max-w-[160px] items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-slate-700" title={baseBranch}>
            <GitBranch size={12} className="flex-shrink-0" />
            <span className="truncate">{baseBranch}</span>
          </span>
        </div>
        <StudioPhaseSwitcher counts={planLength !== undefined ? { review: planLength } : undefined} />
      </div>

      <div data-testid="plan-editor-tool-cluster" className="flex items-center gap-2 flex-shrink-0">
        {/* Secondary navigation: the source prompt and the way back to setup */}
        <div className="flex items-center rounded-md border border-slate-200 bg-white divide-x divide-slate-200">
          {originalPrompt && (
            <OriginalPromptPopover prompt={originalPrompt} buttonClassName={SECONDARY_GROUP_BUTTON_CLASS} labelClassName="hidden 2xl:inline" />
          )}
          {/* Labels only on wide screens so the plan title keeps its room on the title row */}
          <button
            onClick={onBackToSetup}
            disabled={actionDisabled}
            className={SECONDARY_GROUP_BUTTON_CLASS}
            title={getReadOnlyTitle(isReadOnly, 'Back to Setup')}
            aria-label="Back to Setup"
          >
            <ArrowLeft size={14} />
            <span className="hidden 2xl:inline">Back to Setup</span>
          </button>
        </div>
        {/* Undo / Redo / History as one segmented icon pill */}
        <div className="flex items-center rounded-md border border-slate-200 bg-white divide-x divide-slate-200">
          <button
            onClick={onUndo}
            disabled={!canUndo || isReadOnly}
            className={ICON_GROUP_BUTTON_CLASS}
            title="Undo"
          >
            <Undo2 size={15} />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo || isReadOnly}
            className={ICON_GROUP_BUTTON_CLASS}
            title="Redo"
          >
            <Redo2 size={15} />
          </button>
          {onShowHistory && (
            <button
              onClick={onShowHistory}
              className={ICON_GROUP_BUTTON_CLASS}
              title="Plan history"
            >
              <History size={15} />
            </button>
          )}
        </div>
        {onToggleAssistant && (
          <button
            type="button"
            onClick={onToggleAssistant}
            aria-pressed={isAssistantOpen}
            title={isAssistantOpen ? 'Hide the Assistant to read the plan at full width' : 'Show the Assistant'}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              isAssistantOpen
                ? 'border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <MessageSquare size={14} />
            Assistant
          </button>
        )}
        {onFinalize && planLength !== undefined && (
          <FinalizeButton planLength={planLength} isFinalizing={isFinalizing} isReadOnly={isReadOnly} onFinalize={onFinalize} />
        )}
        <PlanOverflowMenu
          isDeleting={isDeleting}
          deleteDisabled={actionDisabled}
          deleteTitle={getReadOnlyTitle(isReadOnly, 'Delete Plan')}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
};

export const PlanEditorHeader: React.FC<PlanEditorHeaderProps> = (props) => {
  if (props.isMobile) return <PlanEditorMobileHeader {...props} />;
  return <PlanEditorDesktopHeader {...props} />;
};

// Error banner component
interface PlanEditorErrorBannerProps {
  error: string | null;
  isMobile?: boolean;
}

export const PlanEditorErrorBanner: React.FC<PlanEditorErrorBannerProps> = ({ error, isMobile }) => {
  if (!error) return null;

  return (
    <div className={`${isMobile ? 'px-3 py-2 text-xs' : 'px-4 py-2 text-sm'} bg-red-50 border-b border-red-200 text-red-700 flex items-center gap-2 flex-shrink-0`}>
      <AlertCircle size={isMobile ? 12 : 14} />
      {error}
    </div>
  );
};
