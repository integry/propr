/**
 * Needs attention: the short list of things only a person can resolve.
 *
 * The list is derived from work state, never from notification state, so
 * dismissing something in the inbox does not make a blocker disappear here.
 *
 * The panel is a fixed structural block, not a conditional one. It is the top
 * module of the console's right column, and unmounting it when the list
 * empties collapsed that column: the stats panel floated up into the triage
 * slot, the row rule the two columns share went with it, and the bottom of
 * the rail became a band of white with a vertical rule running down through
 * it. So an empty list is drawn, not removed — one quiet line inside the same
 * heading, holding the same geometry as four rows would.
 */

import React, { useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import { getDashboardAttention, type AttentionItem, type DashboardAttentionResponse } from '../../api/dashboardApi';
import {
  RepositoryLabel,
  RowLink,
  RowTitle,
  SectionError,
  SectionHeading,
  SectionLink,
  SectionSkeleton,
  SectionZeroState,
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

/**
 * What the row is about, in the row's one prominent line.
 *
 * Never the entity number. `Pull request #2482` under a `PR #2482` chip is the
 * chip read twice: the line that is supposed to say what someone is being
 * asked to look at instead repeats the identifier they can already see, so a
 * row about an untitled pull request tells them nothing they did not know.
 *
 * The API resolves the work's own title first — the issue title, or the branch
 * the run is on when there is no title yet. What is left when even that is
 * unknown is the state the item is in, which is at least a fact about the
 * work: `Pull request is awaiting review`.
 */
function itemTitle(item: AttentionItem): string {
  return item.title || item.detail || 'Untitled work';
}

const AttentionRow: React.FC<{ item: AttentionItem }> = ({ item }) => {
  const href = actionHref(item);
  const external = isExternalHref(href);
  return (
    <li>
      {/*
        One schema for a work row, at every width and in every section.

        Below `lg` this is exactly the shape the running feed and the outcome
        feed use — status opposite elapsed time, then the entities, then the
        title — because three sections stacked down a phone with three
        different hierarchies made the reading plane jump on every scroll.
        Chips sat on line one here and on line two there; the eye had to find
        the pattern again at each heading.

        At `lg` the same five facts re-flow for the narrow rail: status and
        chips share the first line, the title takes the second, and the waiting
        time and its action close the row. Same DOM, same reading order, placed
        rather than duplicated — so nothing is rendered twice and hidden.

        The repository chip carries the repository name alone, as it does in
        every other section: three chips do not fit 320px at full slug length,
        and the one that loses the fight is the repository.
      */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-3 py-2.5 text-xs lg:grid-cols-[auto_minmax(0,1fr)]">
        <span
          className={`min-w-0 truncate whitespace-nowrap font-semibold lg:col-start-1 lg:row-start-1 ${
            item.category === 'blocked' ? 'text-amber-700' : 'text-slate-700'
          }`}
        >
          {REASON_LABELS[item.kind]}
        </span>
        <time
          dateTime={item.since}
          title={new Date(item.since).toLocaleString()}
          className="min-w-0 justify-self-end truncate whitespace-nowrap text-gray-500 lg:col-start-1 lg:row-start-3 lg:justify-self-start"
        >
          Waiting {elapsedLabel(item.since)}
        </time>
        <span className="flex min-w-0 items-center gap-1.5 lg:col-start-2 lg:row-start-1">
          <RepositoryLabel repository={item.repository} />
          <WorkReference issueNumber={item.issueNumber} prNumber={item.prNumber} />
        </span>
        {/*
          Fixed w-20 and centred: every button in the column starts and ends on
          the same two vertical lines whatever its verb.
        */}
        <RowLink
          href={href}
          aria-label={`${actionLabel(item)} ${actionContext(item)}${external ? ' (opens GitHub)' : ''}`}
          className="inline-flex min-h-8 w-20 flex-none items-center justify-center justify-self-end rounded-sm bg-slate-100 px-2 font-semibold text-slate-700 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 lg:col-start-2 lg:row-start-3"
        >
          {actionLabel(item)}
        </RowLink>
        <span className="col-span-2 min-w-0 lg:col-start-1 lg:row-start-2">
          <RowTitle>{itemTitle(item)}</RowTitle>
        </span>
      </div>
    </li>
  );
};

/**
 * Nothing to do, said quietly — and said across the whole pane.
 *
 * This panel is the top of the right column, and its height is set by the
 * running feed beside it rather than by its own content. One line of text at
 * the top of that pane left a 250px cavern beneath it that read as a failed
 * render, so the line is centred in the space it has to fill instead.
 *
 * A shield rather than a tick: the tone is "nothing is wrong", not "well
 * done". It reports a state; it is not a reward.
 */
const AllClear: React.FC = () => (
  <SectionZeroState
    data-testid="needs-attention-empty"
    icon={<ShieldCheck className="h-6 w-6 text-slate-300" aria-hidden="true" />}
  >
    All tasks operational — no attention required
  </SectionZeroState>
);

export const NeedsAttentionPanel: React.FC<DashboardSectionProps> = ({
  repository,
  refreshToken,
}) => {
  const load = useCallback(() => getDashboardAttention(repository), [repository]);
  const { data, error, loading, reload } = useDashboardSection<DashboardAttentionResponse>(
    load,
    repository,
    refreshToken,
  );
  // Waiting durations tick without a network read.
  useNowTick();

  const items = data?.items ?? [];
  const unavailable = Boolean(error) && items.length === 0;
  const visible = items.slice(0, VISIBLE_ITEMS);

  /*
    Heading first, always — including while the first read is in flight and
    when it fails. The heading is what holds the top of the right column on
    the same line as the top of the main column, so it cannot be something
    the panel only draws once it has rows.
  */
  return (
    <section
      aria-labelledby="needs-attention-heading"
      data-testid="needs-attention-panel"
      className="flex h-full min-w-0 flex-col bg-white"
    >
      <SectionHeading
        id="needs-attention-heading"
        title="Needs attention"
        count={loading || unavailable ? null : items.length}
      >
        {items.length > 0 && (
          <SectionLink to={filteredTasksHref('attention', repository)}>View all</SectionLink>
        )}
      </SectionHeading>

      {loading && <SectionSkeleton rows={2} />}
      {!loading && unavailable && (
        <SectionError message="Unable to load what needs attention" onRetry={reload} />
      )}
      {!loading && !unavailable && items.length === 0 && <AllClear />}
      {!loading && items.length > 0 && (
        <ul>
          {visible.map(item => (
            <AttentionRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
};

export default NeedsAttentionPanel;
