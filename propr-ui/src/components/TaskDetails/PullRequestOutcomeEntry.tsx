import React from 'react';
import { GitMerge, GitPullRequestClosed } from 'lucide-react';
import { formatRelativeTime } from '../TaskList/utils.tsx';
import type { PullRequestOutcome } from './pullRequestScores';

const OUTCOME_VIEW = {
  merged: { label: 'Merged', Icon: GitMerge, tone: 'text-violet-700', node: 'border-violet-600 bg-violet-600' },
  closed: { label: 'Closed unmerged', Icon: GitPullRequestClosed, tone: 'text-red-700', node: 'border-red-600 bg-red-600' },
} as const;

interface PullRequestOutcomeEntryProps {
  outcome: PullRequestOutcome;
  /**
   * `rail`: the last row of the run timeline, a node on its trunk after every run.
   * `standalone`: a task with a single run has no rail, so the entry stands on its own after the run.
   */
  variant: 'rail' | 'standalone';
}

/**
 * The task's final entry: whether its pull request was merged. It comes after
 * every run and review rather than inside one, since it is where they all led.
 */
const PullRequestOutcomeEntry: React.FC<PullRequestOutcomeEntryProps> = ({ outcome, variant }) => {
  const { label, Icon, tone, node } = OUTCOME_VIEW[outcome.state];
  const content = (
    <>
      <Icon aria-hidden="true" className={`h-3.5 w-3.5 flex-none ${tone}`} strokeWidth={2.25} />
      <span className={`flex-none font-semibold ${tone}`}>{label}</span>
      <span className="min-w-0 flex-1 truncate text-slate-600">PR #{outcome.prNumber}</span>
      {outcome.at && (
        <time dateTime={outcome.at} title={new Date(outcome.at).toLocaleString()} className="ml-auto flex-none whitespace-nowrap tabular-nums text-slate-400">
          {formatRelativeTime(outcome.at)}
        </time>
      )}
    </>
  );

  if (variant === 'standalone') {
    return (
      <div data-testid="pr-outcome-entry" className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
        {content}
      </div>
    );
  }

  return (
    <li data-testid="pr-outcome-entry" className="relative flex min-w-0 items-center gap-2 py-1.5 pr-1 text-xs leading-5 max-lg:min-h-11 [@media(any-pointer:coarse)]:min-h-11">
      {/* The trunk ends on this node: nothing follows the PR's merge or close. */}
      <span className="relative z-[2] mr-1 flex h-4 w-4 flex-none items-center justify-center bg-white">
        <span aria-hidden="true" data-testid="pr-outcome-node" className={`h-2.5 w-2.5 rounded-full border-2 ${node}`} />
      </span>
      {content}
    </li>
  );
};

export default PullRequestOutcomeEntry;
