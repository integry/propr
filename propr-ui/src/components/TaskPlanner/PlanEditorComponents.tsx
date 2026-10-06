import React, { useState } from 'react';
import { FileQuestion, Info, X, Undo2, Redo2, Loader2, ArrowLeft, Github, GitBranch, Trash2, AlertCircle, History, MessageSquare, MoreHorizontal } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { GranularityEnforcementMetadata } from '../../api/proprApi';

interface OriginalPromptPopoverProps {
  prompt: string;
  buttonClassName?: string;
}

const PROMPT_BUTTON_CLASS = 'flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-full transition-colors text-teal-700 hover:bg-teal-50';

export const OriginalPromptPopover: React.FC<OriginalPromptPopoverProps> = ({ prompt, buttonClassName = PROMPT_BUTTON_CLASS }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={buttonClassName}
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
}

const isPlanActionDisabled = (
  isFinalizing: boolean,
  isResettingToSetup: boolean,
  isDeleting: boolean,
  isReadOnly: boolean
) => isFinalizing || isResettingToSetup || isDeleting || isReadOnly;

const getReadOnlyTitle = (isReadOnly: boolean, title: string) => (
  isReadOnly ? 'Demo mode is read-only' : title
);

const PlanEditorMobileHeader: React.FC<PlanEditorHeaderProps> = ({
  planName,
  repository,
  baseBranch,
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
  isReadOnly = false
}) => {
  const actionDisabled = isPlanActionDisabled(isFinalizing, isResettingToSetup, isDeleting, isReadOnly);

  return (
    <div className="flex flex-col border-b border-gray-200 bg-gray-100 flex-shrink-0">
      {/* First row: Plan name and actions */}
      <div className="flex items-center justify-between px-3 py-2 gap-2">
        <h1 className="text-base font-semibold text-gray-900 truncate min-w-0 flex-1" title={planName}>
          {planName}
        </h1>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onUndo}
            disabled={!canUndo || isReadOnly}
            className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Undo"
          >
            <Undo2 size={16} className="text-gray-600" />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo || isReadOnly}
            className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Redo"
          >
            <Redo2 size={16} className="text-gray-600" />
          </button>
          {onShowHistory && (
            <button
              onClick={onShowHistory}
              className="p-1.5 rounded hover:bg-gray-200 transition-colors"
              title="Plan history"
            >
              <History size={16} className="text-gray-600" />
            </button>
          )}
          <button
            onClick={onBackToSetup}
            disabled={actionDisabled}
            className="p-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={getReadOnlyTitle(isReadOnly, 'Back to Setup')}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            onClick={onDelete}
            disabled={actionDisabled}
            className="p-1.5 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={getReadOnlyTitle(isReadOnly, 'Delete Plan')}
          >
            {isDeleting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Trash2 size={16} />
            )}
          </button>
        </div>
      </div>
      {/* Second row: Repository info */}
      <div className="flex items-center gap-2 px-3 pb-2 text-xs text-gray-600">
        <Github size={12} className="text-gray-500 flex-shrink-0" />
        <span className="truncate">{repository}</span>
        <span className="text-gray-400">/</span>
        <GitBranch size={12} className="text-gray-500 flex-shrink-0" />
        <span className="truncate">{baseBranch}</span>
      </div>
    </div>
  );
};

const SECONDARY_GROUP_BUTTON_CLASS = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed first:rounded-l-md last:rounded-r-md';
const ICON_GROUP_BUTTON_CLASS = 'px-2 py-1.5 text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors first:rounded-l-md last:rounded-r-md';

interface PlanOverflowMenuProps {
  isDeleting: boolean;
  deleteDisabled: boolean;
  deleteTitle: string;
  onDelete: () => void;
}

/** Destructive plan actions live behind "…" so they are never one stray click away. */
const PlanOverflowMenu: React.FC<PlanOverflowMenuProps> = ({ isDeleting, deleteDisabled, deleteTitle, onDelete }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="More plan actions"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="More plan actions"
        className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-200 rounded-md transition-colors"
      >
        {isDeleting ? <Loader2 size={16} className="animate-spin" /> : <MoreHorizontal size={16} />}
      </button>
      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div role="menu" className="absolute right-0 top-full mt-1 z-50 w-44 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            <button
              type="button"
              role="menuitem"
              onClick={() => { setIsOpen(false); onDelete(); }}
              disabled={deleteDisabled}
              title={deleteTitle}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 size={14} />
              Delete plan
            </button>
          </div>
        </>
      )}
    </div>
  );
};

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
  onToggleAssistant
}) => {
  const actionDisabled = isPlanActionDisabled(isFinalizing, isResettingToSetup, isDeleting, isReadOnly);

  const repoName = repository.split('/').pop() || repository;

  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-gray-100 flex-shrink-0 gap-4">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {/* Plan Name - takes the space the actions no longer need */}
        <h1 className="text-lg font-semibold text-gray-900 truncate min-w-0 flex-1" title={planName}>
          {planName}
        </h1>
        {/* Repository and branch as quiet code metadata */}
        <div className="flex items-center gap-2 text-xs flex-shrink-0">
          <span className="font-mono text-slate-600 truncate max-w-[160px]" title={repository}>{repoName}</span>
          <span className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-slate-700">
            <GitBranch size={12} />
            {baseBranch}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Secondary navigation: the source prompt and the way back to setup */}
        <div className="flex items-center rounded-md border border-slate-200 bg-white divide-x divide-slate-200">
          {originalPrompt && (
            <OriginalPromptPopover prompt={originalPrompt} buttonClassName={SECONDARY_GROUP_BUTTON_CLASS} />
          )}
          <button
            onClick={onBackToSetup}
            disabled={actionDisabled}
            className={SECONDARY_GROUP_BUTTON_CLASS}
            title={getReadOnlyTitle(isReadOnly, 'Back to Setup')}
          >
            <ArrowLeft size={14} />
            Back to Setup
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
