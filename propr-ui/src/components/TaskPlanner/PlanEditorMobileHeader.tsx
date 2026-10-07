import React from 'react';
import { ArrowLeft, History, Redo2, Undo2 } from 'lucide-react';
import type { PlanEditorHeaderProps } from './PlanEditorComponents';
import { PlanOverflowMenu, type PlanMenuItem } from './PlanOverflowMenu';
import { StudioPhaseSwitcher } from './StudioStepper';
import { StudioScopePill } from './StudioScopePill';
import { getReadOnlyTitle, isPlanActionDisabled } from './planEditorHeaderUtils';

/** Undo, Redo and History sit behind "…" on a phone, above Delete, so the title row keeps its width. */
function buildMobileEditorMenuItems({ canUndo, canRedo, isReadOnly = false, onUndo, onRedo, onShowHistory }: PlanEditorHeaderProps): PlanMenuItem[] {
  const items: PlanMenuItem[] = [
    { label: 'Undo', icon: <Undo2 size={14} />, onSelect: onUndo, disabled: !canUndo || isReadOnly },
    { label: 'Redo', icon: <Redo2 size={14} />, onSelect: onRedo, disabled: !canRedo || isReadOnly },
  ];
  if (onShowHistory) items.push({ label: 'Plan history', icon: <History size={14} />, onSelect: onShowHistory });
  return items;
}

/**
 * Phone header in two tiers: Back leads the scope pill on the top-left edge, where mobile back
 * navigation lives, far from Delete; the plan title then gets its own line with only the "…" menu beside it.
 */
export const PlanEditorMobileHeader: React.FC<PlanEditorHeaderProps> = (props) => {
  const { planName, repository, baseBranch, isDeleting, isFinalizing, isResettingToSetup, onDelete, onBackToSetup, isReadOnly = false } = props;
  const actionDisabled = isPlanActionDisabled(isFinalizing, isResettingToSetup, isDeleting, isReadOnly);

  return (
    <div className="flex flex-col border-b border-gray-200 bg-gray-100 flex-shrink-0">
      {/* Tier 1: back, scope (repo/branch) and the step badge */}
      <div className="flex items-center gap-2 pl-1.5 pr-3 pt-2" data-testid="plan-editor-mobile-meta-row">
        <button
          onClick={onBackToSetup}
          disabled={actionDisabled}
          className="-my-1 flex-shrink-0 rounded-md p-1.5 text-slate-600 hover:bg-gray-200 hover:text-slate-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={getReadOnlyTitle(isReadOnly, 'Back to Setup')}
          aria-label="Back to Setup"
        >
          <ArrowLeft size={18} />
        </button>
        <StudioScopePill repository={repository} baseBranch={baseBranch} />
        <StudioPhaseSwitcher className="ml-auto" />
      </div>
      {/* Tier 2: the plan title on its own line, with every other action behind "…" */}
      <div className="flex items-center justify-between px-3 py-1.5 gap-2">
        <h1 className="text-base font-semibold text-gray-900 truncate min-w-0 flex-1" title={planName}>
          {planName}
        </h1>
        <PlanOverflowMenu
          isDeleting={isDeleting}
          deleteDisabled={actionDisabled}
          deleteTitle={getReadOnlyTitle(isReadOnly, 'Delete Plan')}
          onDelete={onDelete}
          items={buildMobileEditorMenuItems(props)}
        />
      </div>
    </div>
  );
};
