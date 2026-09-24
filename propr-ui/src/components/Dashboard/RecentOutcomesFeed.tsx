/**
 * Recent outcomes: a flat feed of results that actually mean something.
 *
 * One line per result, newest first, with no grouping to unfold. The title is
 * the prominent element; a score only appears when one was recorded, and it
 * uses the design system's quality pill — a fixed-width bracketed shape and
 * number — so the right rail is a straight edge down the feed.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Check, CircleSlash, X, type LucideIcon } from 'lucide-react';
import { getDashboardOutcomes, type DashboardOutcomesResponse, type OutcomeItem, type OutcomeKind } from '../../api/dashboardApi';
import { ScoreBadge } from '../TaskList/ScoreBadge';
import {
  RepositoryLabel,
  RowDetail,
  RowLink,
  RowMetaLines,
  RowTitle,
  SectionEmpty,
  SectionError,
  SectionFooter,
  SectionFooterButton,
  SectionHeading,
  SectionSkeleton,
  WorkReference,
} from './sectionPrimitives';
import {
  type DashboardSectionProps,
  elapsedLabel,
  useDashboardSection,
  useNowTick,
  workHref,
} from './sectionState';

/** Outcomes read per request; the window and the visible count narrow it further. */
const FETCH_LIMIT = 50;
const VISIBLE_ITEMS = 8;

/** Rows drawn rather than folded behind a toggle, as in "Happening now". */
const OVERFLOW_SLACK = 1;

type OutcomeWindow = '24h' | '7d';

const WINDOW_HOURS: Record<OutcomeWindow, number> = { '24h': 24, '7d': 24 * 7 };
const WINDOW_LABELS: Record<OutcomeWindow, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days' };

const KIND_LABELS: Record<OutcomeKind, string> = {
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  merged: 'Merged',
  closed: 'Closed',
};

/**
 * Colour is spent only where it changes what someone does. A failure is the
 * one outcome worth interrupting for; completed, merged, cancelled and closed
 * are all history, so they recede into slate.
 */
const KIND_CLASSES: Record<OutcomeKind, string> = {
  completed: 'text-slate-600',
  failed: 'text-red-700',
  cancelled: 'text-slate-500',
  merged: 'text-slate-600',
  closed: 'text-slate-500',
};

/**
 * Every outcome carries a glyph, because a status column where only some
 * states have an icon reads as a rendering bug rather than as a distinction:
 * the eye sees a ragged column, not "these two are successes". The glyph is
 * what separates the end states; colour is still spent only on failure, and
 * the two successful states share one glyph so they stay indistinguishable.
 */
const KIND_ICONS: Record<OutcomeKind, LucideIcon> = {
  completed: Check,
  merged: Check,
  failed: X,
  cancelled: CircleSlash,
  closed: CircleSlash,
};

/**
 * What finished, in the row's one prominent line — never its own chip.
 *
 * `Pull request #2467` above a `PR #2467` chip is the identifier printed
 * twice and the work named not at all. The API resolves the title of the run
 * behind an outcome, including for a merge recorded against a plan issue; what
 * is left when even that is unknown is what happened to it, which is at least
 * a fact about the work.
 */
function outcomeTitle(item: OutcomeItem): string {
  return item.title || item.detail || 'Untitled work';
}

/** The status cell: one glyph plus one word, the same shape for every kind. */
const OutcomeKindLabel: React.FC<{ kind: OutcomeKind }> = ({ kind }) => {
  const Icon = KIND_ICONS[kind];
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${KIND_CLASSES[kind]}`}>
      <Icon className="h-3 w-3 flex-none" aria-hidden="true" />
      {KIND_LABELS[kind]}
    </span>
  );
};

const OutcomeRow: React.FC<{ item: OutcomeItem }> = ({ item }) => {
  const title = outcomeTitle(item);
  return (
    <li>
      <RowLink
        href={workHref(item)}
        className="flex min-w-0 items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
      >
        <span className="min-w-0 flex-1">
          <RowMetaLines
            status={<OutcomeKindLabel kind={item.kind} />}
            entities={(
              <>
                <RepositoryLabel repository={item.repository} />
                <WorkReference issueNumber={item.issueNumber} prNumber={item.prNumber} />
              </>
            )}
            trailing={(
              <time dateTime={item.occurredAt} title={new Date(item.occurredAt).toLocaleString()}>
                {elapsedLabel(item.occurredAt)} ago
              </time>
            )}
          />
          <RowTitle>{title}</RowTitle>
          {/* Never the same sentence twice: a detail promoted to the title is not repeated under it. */}
          {item.detail && item.detail !== title && <RowDetail>{item.detail}</RowDetail>}
        </span>
        {/*
          Rendered only when a score exists, so no empty column is reserved.

          The scale is carried by the shape and by the assistive-technology
          label, never as visible `/10` prose: floating prose next to a
          fixed-width badge puts variable-width glyphs outside the w-12 box and
          makes the right rail shift by a pixel or two between 7, 8 and 9.

          On a phone the badge centres against the row rather than hanging off
          its first line, where it used to crowd the status word and push the
          timestamp onto a line of its own.
        */}
        {item.score !== null && item.score !== undefined && (
          <span className="flex flex-none items-baseline self-center sm:mt-0.5 sm:self-start" data-testid="outcome-score">
            <ScoreBadge score={item.score} bracketed />
            <span className="sr-only">Code quality score {item.score} out of 10</span>
          </span>
        )}
      </RowLink>
    </li>
  );
};

export const RecentOutcomesFeed: React.FC<DashboardSectionProps> = ({ repository, refreshToken }) => {
  const [range, setRange] = useState<OutcomeWindow>('24h');
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => getDashboardOutcomes(repository, FETCH_LIMIT), [repository]);
  const { data, error, loading, reload } = useDashboardSection<DashboardOutcomesResponse>(
    load,
    repository,
    refreshToken,
  );
  const now = useNowTick(60_000);

  const items = useMemo(() => {
    const cutoff = now - WINDOW_HOURS[range] * 60 * 60 * 1000;
    return (data?.items ?? []).filter(item => Date.parse(item.occurredAt) >= cutoff);
  }, [data, now, range]);

  const canCollapse = items.length > VISIBLE_ITEMS + OVERFLOW_SLACK;
  const overflowCount = canCollapse ? items.length - VISIBLE_ITEMS : 0;
  const visible = showAll || !canCollapse ? items : items.slice(0, VISIBLE_ITEMS);

  const body = () => {
    if (loading) return <SectionSkeleton rows={4} />;
    if (error && (data?.items ?? []).length === 0) {
      return <SectionError message="Unable to load recent outcomes" onRetry={reload} />;
    }
    if (items.length === 0) {
      return <SectionEmpty>Nothing finished in the {WINDOW_LABELS[range].toLowerCase()}</SectionEmpty>;
    }
    return (
      <>
        <ul data-testid="recent-outcomes-list">
          {visible.map(item => (
            <OutcomeRow key={item.id} item={item} />
          ))}
        </ul>
        {/*
          The expand control closes the pane as a footer bar rather than
          floating as a centred link in the white space under the last row.
        */}
        {overflowCount > 0 && (
          <SectionFooter data-testid="recent-outcomes-footer">
            <span className="ml-auto">
              <SectionFooterButton expanded={showAll} onClick={() => setShowAll(value => !value)}>
                {showAll ? 'Show fewer' : `Show ${overflowCount} more`}
              </SectionFooterButton>
            </span>
          </SectionFooter>
        )}
      </>
    );
  };

  return (
    <section
      aria-labelledby="recent-outcomes-heading"
      data-testid="recent-outcomes-section"
      className="min-w-0 bg-white"
    >
      <SectionHeading id="recent-outcomes-heading" title="Recent outcomes">
        <div className="inline-flex rounded-sm bg-slate-200/70 p-0.5" role="group" aria-label="Outcome window">
          {(Object.keys(WINDOW_LABELS) as OutcomeWindow[]).map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={range === option}
              onClick={() => { setRange(option); setShowAll(false); }}
              className={`rounded-sm px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                range === option ? 'bg-white text-slate-800' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {WINDOW_LABELS[option]}
            </button>
          ))}
        </div>
      </SectionHeading>
      {body()}
    </section>
  );
};

export default RecentOutcomesFeed;
