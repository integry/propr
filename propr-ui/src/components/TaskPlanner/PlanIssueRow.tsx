import React, { useCallback, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink } from 'lucide-react';
import { PlanIssue, AgentModelPair, type PlanExecutionQueueIssue } from '../../api/planIssuesApi';
import type { InstanceCatalogAgent } from '@propr/shared';
import { PlanTask } from '../../api/plannerApi';
import {
  StatusBadge,
  RowActions,
  ExpandedContent,
  IssueMetadata
} from './PlanIssueRowComponents';
import { getContainerClassName, getTitleClassName } from './planIssueRowUtils';
import { getOutlineTitle } from './planDisplayName';
import type { PlanIssueDefaultSelection } from './planIssueDefaultSelection';
import { PlanIssueQueueNotice } from './PlanIssueQueueNotice';
import type { PlanQueueAction } from './usePlanQueueActions';
import type { RowQueueStatus } from './planQueueLabels';

interface PlanIssueRowProps {
  issue: PlanIssue;
  issueTitle?: string;
  agents: InstanceCatalogAgent[];
  onImplement: (issueNumber: number, models?: AgentModelPair[]) => void;
  onAgentChange: (issueNumber: number, agentAlias: string | null) => void;
  onModelChange: (issueNumber: number, modelName: string | null) => void;
  /** Plan default agent/model (the toolbar selection); the override popover can reset to it. */
  defaultSelection?: PlanIssueDefaultSelection | null;
  implementing?: boolean;
  disableImplementation?: boolean;
  isFirstPending?: boolean;
  /** Pending, but owned by the execution queue: it starts once the issue ahead of it finishes. */
  isQueued?: boolean;
  onImplementWithWarning?: (issueNumber: number, models?: AgentModelPair[]) => void;
  /** Inherited multi-mode state from parent (e.g., applied from global selection) */
  inheritedIsMulti?: boolean;
  /** Inherited selected models from parent (e.g., applied from global selection) */
  inheritedSelectedModels?: AgentModelPair[];
  /** Callback when multi-mode is toggled */
  onMultiToggle?: (isMulti: boolean) => void;
  /** Callback when multi-model selection changes */
  onMultiModelChange?: (models: AgentModelPair[]) => void;
  /** Full task specification data for expandable details */
  task?: PlanTask;
  /** Draft ID for attachment URLs */
  draftId?: string;
  implementButtonPressed?: boolean;
  showImplementButton?: boolean;
  implementButtonLabel?: string;
  /** The issue's state in the plan's active execution queue, when it is part of one. */
  queueState?: PlanExecutionQueueIssue;
  /** Queued, Skipped or Blocked: how a pending issue stands in the queue, for its status pill. */
  queueStatus?: RowQueueStatus | null;
  /** Issues this one starts after. */
  dependsOn?: number[];
  /** Prerequisites not merged yet that this pending issue waits for. */
  waitingOn?: number[];
  /** Graph issues that depend on this one. */
  queueDependents?: number[];
  /** The queue action in progress for this issue. */
  queueAction?: PlanQueueAction | null;
  onQueueAction?: (issueNumber: number, action: PlanQueueAction) => void;
}

/** Renders the execution-queue notice only for rows that belong to an active queue; read-only rows explain blockers without actions. */
const RowQueueNotice: React.FC<{
  issueNumber: number;
  state?: PlanExecutionQueueIssue;
  dependents?: number[];
  pendingAction?: PlanQueueAction | null;
  disabled: boolean;
  onAction?: (issueNumber: number, action: PlanQueueAction) => void;
}> = ({ issueNumber, state, dependents, pendingAction, disabled, onAction }) => {
  if (!state) return null;
  return (
    <PlanIssueQueueNotice state={state} dependents={dependents} pendingAction={pendingAction}
      disabled={disabled} onAction={onAction ? action => onAction(issueNumber, action) : undefined} />
  );
};

export const PlanIssueRow: React.FC<PlanIssueRowProps> = ({
  issue,
  issueTitle,
  agents,
  onImplement,
  onAgentChange,
  onModelChange,
  defaultSelection,
  implementing = false,
  disableImplementation = false,
  isFirstPending = true,
  isQueued = false,
  onImplementWithWarning,
  inheritedIsMulti,
  inheritedSelectedModels,
  onMultiToggle: onMultiToggleProp,
  onMultiModelChange: onMultiModelChangeProp,
  task,
  draftId,
  implementButtonPressed = false,
  showImplementButton = true,
  implementButtonLabel = 'Implement',
  queueState,
  queueStatus,
  dependsOn,
  waitingOn,
  queueDependents,
  queueAction,
  onQueueAction,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Use inherited state from parent if available, otherwise fall back to local state
  const isMultiMode = inheritedIsMulti ?? false;
  const selectedModels = useMemo(
    () => inheritedSelectedModels ?? [],
    [inheritedSelectedModels]
  );

  const isPending = issue.status === 'pending';
  const isMerged = issue.status === 'merged';

  const issueUrl = `https://github.com/${issue.repository}/issues/${issue.issue_number}`;

  const hasAgent = isMultiMode ? selectedModels.length > 0 : !!issue.agent_alias;

  // Determine if there is expandable content (including attachments)
  const hasExpandableContent = !!(task && (task.body || task.implementation || task.notes || (task.attachments && task.attachments.length > 0)));

  const handleMultiToggle = useCallback((multi: boolean) => {
    onMultiToggleProp?.(multi);
  }, [onMultiToggleProp]);

  const handleMultiModelChange = useCallback((models: AgentModelPair[]) => {
    onMultiModelChangeProp?.(models);
  }, [onMultiModelChangeProp]);

  const handleImplementClick = useCallback(() => {
    const models = isMultiMode && selectedModels.length > 0 ? selectedModels : undefined;
    const handler = isFirstPending || !onImplementWithWarning ? onImplement : onImplementWithWarning;
    handler(issue.issue_number, models);
  }, [isMultiMode, selectedModels, isFirstPending, onImplementWithWarning, onImplement, issue.issue_number]);

  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(prev => !prev);
  }, []);

  // Click on the row to expand (but not on interactive elements)
  const handleRowClick = useCallback((e: React.MouseEvent) => {
    // Only toggle expand if clicking on non-interactive area and there's expandable content
    const target = e.target as HTMLElement;
    const isInteractive = target.closest('button, a, select, input, [role="button"]');
    if (!isInteractive && hasExpandableContent) {
      setIsExpanded(prev => !prev);
    }
  }, [hasExpandableContent]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`${getContainerClassName(isMerged)} overflow-hidden`}
      data-testid="plan-execution-row"
    >
      {/* High-Density Collapsed Row - Status, Title, and Actions */}
      <div
        className={`px-4 py-2 ${hasExpandableContent ? 'cursor-pointer' : ''}`}
        onClick={handleRowClick}
      >
        {/*
          One wrapping line: number and status, the title, then metadata and actions. Below lg the title
          always takes its own full-width line under the number and status; from lg it shares the line
          while it keeps at least 18rem, and the metadata and actions wrap under it otherwise. The title
          wraps to two lines, then ends in an ellipsis (full title in the tooltip and the expanded section).
        */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="order-1 flex flex-shrink-0 items-center gap-3">
            <a
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-16 font-mono text-xs text-slate-600 hover:text-primary-600 transition-colors flex items-center gap-1 flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              #{issue.issue_number}
              <ExternalLink size={10} className="opacity-50" />
            </a>
            <span className="w-24 flex-shrink-0"><StatusBadge status={issue.status} queued={isQueued} queueStatus={queueStatus} /></span>
          </div>
          {issueTitle && (
            // The plan name and step counter ("Agents v1 (6/17):") repeat on every row, so rows lead with the step itself.
            <span data-testid="plan-issue-title"
              className={`order-3 min-w-0 basis-full break-words text-sm leading-5 line-clamp-2 lg:order-2 lg:flex-1 lg:basis-[18rem] ${getTitleClassName(isMerged)}`}
              title={issueTitle}>
              {getOutlineTitle(issueTitle)}
            </span>
          )}
          <IssueMetadata issue={issue} dependsOn={dependsOn} waitingOn={waitingOn} className="order-2 ml-auto lg:order-3" />
          <div className="order-4 ml-auto flex min-w-0 items-center">
            <RowActions
              isPending={isPending}
              hasExpandableContent={hasExpandableContent}
              isExpanded={isExpanded}
              implementing={implementing}
              isMultiMode={isMultiMode}
              selectedModels={selectedModels}
              hasAgent={hasAgent}
              isFirstPending={isFirstPending}
              agents={agents}
              issue={issue}
              onAgentChange={onAgentChange}
              onModelChange={onModelChange}
              defaultSelection={defaultSelection}
              disableImplementation={disableImplementation}
              implementButtonPressed={implementButtonPressed}
              showImplementButton={showImplementButton}
              implementButtonLabel={implementButtonLabel}
              handleMultiToggle={handleMultiToggle}
              handleMultiModelChange={handleMultiModelChange}
              handleImplementClick={handleImplementClick}
              handleToggleExpand={handleToggleExpand}
            />
          </div>
        </div>
        <RowQueueNotice issueNumber={issue.issue_number} state={queueState} dependents={queueDependents}
          pendingAction={queueAction} disabled={disableImplementation} onAction={onQueueAction} />
      </div>

      {/* Expandable Content */}
      <AnimatePresence initial={false}>
        {isExpanded && hasExpandableContent && task && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ExpandedContent task={task} draftId={draftId} title={issueTitle} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default PlanIssueRow;
