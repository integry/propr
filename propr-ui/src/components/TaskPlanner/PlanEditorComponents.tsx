import React, { useState } from 'react';
import { FileQuestion, Info, X, Undo2, Redo2, Loader2, ArrowLeft, Github, GitBranch, Trash2, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { GranularityEnforcementMetadata } from '../../api/proprApi';

interface OriginalPromptPopoverProps {
  prompt: string;
}

export const OriginalPromptPopover: React.FC<OriginalPromptPopoverProps> = ({ prompt }) => {
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
  isMobile?: boolean;
  isReadOnly?: boolean;
}

export const PlanEditorHeader: React.FC<PlanEditorHeaderProps> = ({
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
  isMobile,
  isReadOnly = false
}) => {
  // Mobile header - compact layout
  if (isMobile) {
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
            <button
              onClick={onBackToSetup}
              disabled={isFinalizing || isResettingToSetup || isDeleting || isReadOnly}
              className="p-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={isReadOnly ? 'Demo mode is read-only' : 'Back to Setup'}
            >
              <ArrowLeft size={16} />
            </button>
            <button
              onClick={onDelete}
              disabled={isFinalizing || isResettingToSetup || isDeleting || isReadOnly}
              className="p-1.5 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={isReadOnly ? 'Demo mode is read-only' : 'Delete Plan'}
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
  }

  // Desktop header - original layout
  return (
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
        {/* Original Prompt - moved to header */}
        {originalPrompt && (
          <>
            <div className="h-4 w-px bg-gray-300 flex-shrink-0 hidden lg:block" />
            <div className="hidden lg:block">
              <OriginalPromptPopover prompt={originalPrompt} />
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Delete Plan */}
        <button
          onClick={onDelete}
          disabled={isFinalizing || isResettingToSetup || isDeleting || isReadOnly}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={isReadOnly ? 'Demo mode is read-only' : 'Delete Plan'}
        >
          {isDeleting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Trash2 size={16} />
          )}
        </button>
        <div className="h-6 w-px bg-gray-300 mx-1" />
        {/* Back to Setup */}
        <button
          onClick={onBackToSetup}
          disabled={isFinalizing || isResettingToSetup || isDeleting || isReadOnly}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={isReadOnly ? 'Demo mode is read-only' : 'Back to Setup'}
        >
          <ArrowLeft size={16} />
          Back to Setup
        </button>
        <div className="h-6 w-px bg-gray-300 mx-1" />
        {/* Undo/Redo */}
        <div className="flex items-center gap-1">
          <button
            onClick={onUndo}
            disabled={!canUndo || isReadOnly}
            className="p-2 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Undo"
          >
            <Undo2 size={18} className="text-gray-600" />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo || isReadOnly}
            className="p-2 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Redo"
          >
            <Redo2 size={18} className="text-gray-600" />
          </button>
        </div>
      </div>
    </div>
  );
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
