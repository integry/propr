import React from 'react';
import type { Task } from './types';

/**
 * Monospace "code chip" for technical entities (PR numbers, issue numbers, task ids),
 * per the Studio design guidelines. Neutral slate only: no colored icons.
 */
export const ReferenceChip: React.FC<{ children: React.ReactNode; title?: string }> = ({ children, title }) => (
  <span
    className="inline-flex items-center whitespace-nowrap font-mono text-[12px] leading-4 bg-slate-100 border border-slate-200 text-slate-800 rounded-sm px-1.5 py-0.5"
    title={title}
  >
    {children}
  </span>
);

/**
 * PR / Issue chips for a task. Each chip is prefixed with its entity type, and
 * the issue chip is omitted when it would repeat the PR number (a PR task's
 * issueNumber is the PR itself).
 */
export const TaskReferenceChips: React.FC<{ task: Task; prNumber?: number | null }> = ({ task, prNumber }) => {
  const issueToShow = task.linkedIssueNumber || task.issueNumber;
  const showIssue = Boolean(issueToShow) && issueToShow !== prNumber;

  if (!prNumber && !showIssue) {
    return <ReferenceChip title={`Task ${task.id}`}>#{task.id.substring(0, 8)}</ReferenceChip>;
  }

  return (
    <>
      {prNumber ? <ReferenceChip title={`Pull request #${prNumber}`}>PR #{prNumber}</ReferenceChip> : null}
      {showIssue ? <ReferenceChip title={`Issue #${issueToShow}`}>Issue #{issueToShow}</ReferenceChip> : null}
    </>
  );
};
