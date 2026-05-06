import React, { useCallback, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink } from 'lucide-react';
import { PlanIssue, STATUS_CONFIG, AgentModelPair } from '../../api/planIssuesApi';
import { AgentConfig } from '../../api/proprApi';
import { PlanTask } from '../../api/plannerApi';
import {
  StatusBadge,
  RowActions,
  ExpandedContent,
  IssueMetadata
} from './PlanIssueRowComponents';
import { getContainerClassName, getTitleClassName } from './planIssueRowUtils';

interface PlanIssueRowProps {
  issue: PlanIssue;
  issueTitle?: string;
  agents: AgentConfig[];
  onImplement: (issueNumber: number, models?: AgentModelPair[]) => void;
  onAgentChange: (issueNumber: number, agentAlias: string | null) => void;
  onModelChange: (issueNumber: number, modelName: string | null) => void;
  onRunUltrafixChange: (issueNumber: number, runUltrafix: boolean | null) => void;
  onUltrafixGoalChange: (issueNumber: number, value: number | null) => void;
  onUltrafixMaxCyclesChange: (issueNumber: number, value: number | null) => void;
  plannerRunUltrafix?: boolean;
  plannerUltrafixGoal?: number | null;
  plannerUltrafixMaxCycles?: number | null;
  implementing?: boolean;
  isFirstPending?: boolean;
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
}

export const PlanIssueRow: React.FC<PlanIssueRowProps> = ({
  issue,
  issueTitle,
  agents,
  onImplement,
  onAgentChange,
  onModelChange,
  onRunUltrafixChange,
  onUltrafixGoalChange,
  onUltrafixMaxCyclesChange,
  plannerRunUltrafix,
  plannerUltrafixGoal,
  plannerUltrafixMaxCycles,
  implementing = false,
  isFirstPending = true,
  onImplementWithWarning,
  inheritedIsMulti,
  inheritedSelectedModels,
  onMultiToggle: onMultiToggleProp,
  onMultiModelChange: onMultiModelChangeProp,
  task,
  draftId
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
  const isProcessing = issue.status === 'processing' || issue.status === 'refinement_processing';

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
      className={`border rounded-lg ${getContainerClassName(isMerged)} overflow-hidden`}
    >
      {/* High-Density Collapsed Row - Status, Title, and Actions */}
      <div
        className={`px-3 sm:px-4 py-2 ${hasExpandableContent ? 'cursor-pointer' : ''}`}
        onClick={handleRowClick}
      >
        {/* Mobile: Stack layout, Desktop: Single line */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
          {/* Top row (mobile) / Left side (desktop): Issue Number + Status Badge + Title */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <a
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs px-1.5 py-0.5 bg-gray-100 border border-gray-200 rounded-sm text-gray-700 hover:bg-gray-200 hover:text-primary-600 transition-colors flex items-center gap-1 flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              #{issue.issue_number}
              <ExternalLink size={10} className="opacity-50" />
            </a>
            <StatusBadge status={issue.status} />
            {issueTitle && (
              <span className={`text-sm ${getTitleClassName(isMerged)} truncate`}>
                {issueTitle}
              </span>
            )}
          </div>

          {/* Bottom row (mobile) / Right side (desktop): Metadata + Actions */}
          <div className="flex items-center justify-between sm:justify-end gap-2 sm:gap-3 flex-shrink-0">
            <IssueMetadata issue={issue} isPending={isPending} isProcessing={isProcessing} selectedModels={selectedModels} />
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
              onRunUltrafixChange={onRunUltrafixChange}
              onUltrafixGoalChange={onUltrafixGoalChange}
              onUltrafixMaxCyclesChange={onUltrafixMaxCyclesChange}
              plannerRunUltrafix={plannerRunUltrafix}
              plannerUltrafixGoal={plannerUltrafixGoal}
              plannerUltrafixMaxCycles={plannerUltrafixMaxCycles}
              handleMultiToggle={handleMultiToggle}
              handleMultiModelChange={handleMultiModelChange}
              handleImplementClick={handleImplementClick}
              handleToggleExpand={handleToggleExpand}
            />
          </div>
        </div>
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
            <ExpandedContent task={task} draftId={draftId} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default PlanIssueRow;
