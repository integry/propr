/**
 * Recent outcomes: a flat feed of results that actually mean something.
 *
 * One line per result, newest first, with no grouping to unfold. The title is
 * the prominent element; a score only appears when one was recorded, and it
 * uses the design system's quality pill — a fixed-width bracketed shape and
 * number — so the right rail is a straight edge down the feed.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { getDashboardOutcomes, type DashboardOutcomesResponse, type OutcomeItem, type OutcomeKind } from '../../api/dashboardApi';
import { ScoreBadge } from '../TaskList/ScoreBadge';
import {
  Dot,
  RepositoryLabel,
  RowDetail,
  RowLink,
  RowMeta,
  RowTitle,
  SectionEmpty,
  SectionError,
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

/** Successful end states carry a checkmark instead of a colour. */
const SUCCESS_KINDS: ReadonlySet<OutcomeKind> = new Set<OutcomeKind>(['completed', 'merged']);

function outcomeTitle(item: OutcomeItem): string {
  if (item.title) return item.title;
  if (item.prNumber) return `Pull request #${item.prNumber}`;
  if (item.issueNumber) return `Issue #${item.issueNumber}`;
  return 'Untitled work';
}

const OutcomeRow: React.FC<{ item: OutcomeItem }> = ({ item }) => (
  <li className="border-b border-slate-100 last:border-b-0">
    <RowLink
      href={workHref(item)}
      className="flex min-w-0 items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
    >
      <span className="min-w-0 flex-1">
        <RowMeta>
          <span className={`inline-flex items-center gap-1 font-medium ${KIND_CLASSES[item.kind]}`}>
            {SUCCESS_KINDS.has(item.kind) && <Check className="h-3 w-3 flex-none" aria-hidden="true" />}
            {KIND_LABELS[item.kind]}
          </span>
          <Dot />
          <RepositoryLabel repository={item.repository} />
          <WorkReference issueNumber={item.issueNumber} prNumber={item.prNumber} />
          <Dot />
          <time dateTime={item.occurredAt} title={new Date(item.occurredAt).toLocaleString()} className="whitespace-nowrap text-gray-500">
            {elapsedLabel(item.occurredAt)} ago
          </time>
        </RowMeta>
        <RowTitle>{outcomeTitle(item)}</RowTitle>
        {item.detail && <RowDetail>{item.detail}</RowDetail>}
      </span>
      {/*
        Rendered only when a score exists, so no empty column is reserved.

        The scale is carried by the shape and by the assistive-technology
        label, never as visible `/10` prose: floating prose next to a
        fixed-width badge puts variable-width glyphs outside the w-12 box and
        makes the right rail shift by a pixel or two between 7, 8 and 9.
      */}
      {item.score !== null && item.score !== undefined && (
        <span className="mt-0.5 flex flex-none items-baseline" data-testid="outcome-score">
          <ScoreBadge score={item.score} bracketed />
          <span className="sr-only">Code quality score {item.score} out of 10</span>
        </span>
      )}
    </RowLink>
  </li>
);

export const RecentOutcomesFeed: React.FC<DashboardSectionProps> = ({ repository, refreshToken, onLoaded }) => {
  const [range, setRange] = useState<OutcomeWindow>('24h');
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => getDashboardOutcomes(repository, FETCH_LIMIT), [repository]);
  const { data, error, loading, reload } = useDashboardSection<DashboardOutcomesResponse>(
    load,
    repository,
    refreshToken,
    onLoaded,
  );
  const now = useNowTick(60_000);

  const items = useMemo(() => {
    const cutoff = now - WINDOW_HOURS[range] * 60 * 60 * 1000;
    return (data?.items ?? []).filter(item => Date.parse(item.occurredAt) >= cutoff);
  }, [data, now, range]);

  const visible = showAll ? items : items.slice(0, VISIBLE_ITEMS);

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
        {items.length > VISIBLE_ITEMS && (
          <button
            type="button"
            onClick={() => setShowAll(value => !value)}
            className="w-full border-t border-slate-100 px-3 py-2 text-left text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
          >
            {showAll ? 'Show fewer' : `Show ${items.length - VISIBLE_ITEMS} more`}
          </button>
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
        <div className="inline-flex rounded-sm border border-slate-200 bg-white p-0.5" role="group" aria-label="Outcome window">
          {(Object.keys(WINDOW_LABELS) as OutcomeWindow[]).map(option => (
            <button
              key={option}
              type="button"
              aria-pressed={range === option}
              onClick={() => { setRange(option); setShowAll(false); }}
              className={`rounded-sm px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                range === option ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:text-slate-700'
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
