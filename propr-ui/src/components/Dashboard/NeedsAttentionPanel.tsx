/**
 * Needs attention: the short list of things only a person can resolve.
 *
 * The list is derived from work state, never from notification state, so
 * dismissing something in the inbox does not make a blocker disappear here.
 * When it is empty the panel gets out of the way entirely rather than
 * occupying a column with a reassuring graphic.
 */

import React, { useCallback, useEffect } from 'react';
import { getDashboardAttention, type AttentionItem, type DashboardAttentionResponse } from '../../api/dashboardApi';
import {
  Dot,
  RepositoryLabel,
  RowLink,
  RowMeta,
  RowTitle,
  SectionError,
  SectionHeading,
  SectionLink,
  SectionSkeleton,
  WorkReference,
} from './sectionPrimitives';
import {
  type DashboardSectionProps,
  elapsedLabel,
  filteredTasksHref,
  isExternalHref,
  useDashboardSection,
  useNowTick,
  workHref,
} from './sectionState';

/** How many items the panel shows before handing off to the full list. */
const VISIBLE_ITEMS = 3;

const REASON_LABELS: Record<AttentionItem['kind'], string> = {
  task_failed: 'Run failed',
  task_action_required: 'Waiting on you',
  plan_review: 'Review requested',
};

/**
 * One word, always.
 *
 * The button sits in a fixed right rail, so the label has to be a fixed-width
 * verb: "Open task" beside "Review pull request" moved every button's left
 * edge by ten characters and made the column look unaligned. What is being
 * opened or reviewed is already named by the row's chip and title directly
 * above, so the entity belongs in the accessible name, not on the button face.
 */
function actionLabel(item: AttentionItem): string {
  return item.kind === 'plan_review' ? 'Review' : 'Open';
}

/**
 * The entity the verb acts on.
 *
 * It rides in the button's `aria-label` rather than in a visually hidden span:
 * a hidden span is joined to the visible verb without a separator by the
 * accessible-name algorithm, which announces "Openissue #42".
 */
function actionContext(item: AttentionItem): string {
  if (item.prNumber) return `pull request #${item.prNumber}`;
  if (item.issueNumber) return `issue #${item.issueNumber}`;
  return 'task';
}

/** The review decision lives on GitHub; everything else resolves in a task. */
function actionHref(item: AttentionItem): string {
  if (item.kind === 'plan_review') {
    if (item.prNumber) return `https://github.com/${item.repository}/pull/${item.prNumber}`;
    if (item.issueNumber) return `https://github.com/${item.repository}/issues/${item.issueNumber}`;
  }
  return workHref(item);
}

function itemTitle(item: AttentionItem): string {
  if (item.title) return item.title;
  if (item.prNumber) return `Pull request #${item.prNumber}`;
  if (item.issueNumber) return `Issue #${item.issueNumber}`;
  return 'Untitled work';
}

const AttentionRow: React.FC<{ item: AttentionItem }> = ({ item }) => {
  const href = actionHref(item);
  const external = isExternalHref(href);
  return (
    <li className="border-b border-slate-100 last:border-b-0">
      <div className="px-3 py-2.5">
        <RowMeta>
          <span className={`font-semibold ${item.category === 'blocked' ? 'text-amber-700' : 'text-slate-700'}`}>
            {REASON_LABELS[item.kind]}
          </span>
          <Dot />
          <RepositoryLabel repository={item.repository} />
          <WorkReference issueNumber={item.issueNumber} prNumber={item.prNumber} />
        </RowMeta>
        <RowTitle>{itemTitle(item)}</RowTitle>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <time dateTime={item.since} title={new Date(item.since).toLocaleString()} className="min-w-0 truncate text-xs text-gray-500">
            Waiting {elapsedLabel(item.since)}
          </time>
          {/*
            Fixed w-20 and centred: every button in the column starts and ends
            on the same two vertical lines whatever its verb.
          */}
          <RowLink
            href={href}
            aria-label={`${actionLabel(item)} ${actionContext(item)}${external ? ' (opens GitHub)' : ''}`}
            className="inline-flex min-h-8 w-20 flex-none items-center justify-center rounded-sm border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            {actionLabel(item)}
          </RowLink>
        </div>
      </div>
    </li>
  );
};

interface NeedsAttentionPanelProps extends DashboardSectionProps {
  /** Lets the layout drop the column entirely once the list is known empty. */
  onEmptyChange?: (empty: boolean) => void;
  /**
   * Whether an empty list leaves the DOM entirely.
   *
   * Nothing to attend to is the normal case, so by default the section is
   * simply absent rather than occupying a column with a reassuring graphic.
   * A caller that has room for one quiet line — the dashboard's mobile column,
   * where the panel is the only thing between two rules — opts out.
   */
  hideWhenEmpty?: boolean;
}

export const NeedsAttentionPanel: React.FC<NeedsAttentionPanelProps> = ({
  repository,
  refreshToken,
  onLoaded,
  onEmptyChange,
  hideWhenEmpty = true,
}) => {
  const load = useCallback(() => getDashboardAttention(repository), [repository]);
  const { data, error, loading, reload } = useDashboardSection<DashboardAttentionResponse>(
    load,
    repository,
    refreshToken,
    onLoaded,
  );
  // Waiting durations tick without a network read.
  useNowTick();

  const items = data?.items ?? [];
  const isEmpty = data !== null && items.length === 0;
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);

  if (loading) return <SectionSkeleton rows={2} />;

  if (error && items.length === 0) {
    return (
      <section aria-labelledby="needs-attention-heading" data-testid="needs-attention-panel" className="min-w-0 bg-white">
        <SectionHeading id="needs-attention-heading" title="Needs attention" />
        <SectionError message="Unable to load what needs attention" onRetry={reload} />
      </section>
    );
  }

  // Nothing to do: no panel at all on desktop, one quiet line on mobile.
  if (items.length === 0) {
    if (hideWhenEmpty) return null;
    return (
      <p data-testid="needs-attention-empty" className="px-3 py-3 text-sm text-slate-500 lg:hidden">
        Nothing needs your attention
      </p>
    );
  }

  const visible = items.slice(0, VISIBLE_ITEMS);

  return (
    <section
      aria-labelledby="needs-attention-heading"
      data-testid="needs-attention-panel"
      className="min-w-0 bg-white"
    >
      <SectionHeading id="needs-attention-heading" title="Needs attention" count={items.length}>
        <SectionLink to={filteredTasksHref('attention', repository)}>View all</SectionLink>
      </SectionHeading>
      <ul>
        {visible.map(item => (
          <AttentionRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
};

export default NeedsAttentionPanel;
