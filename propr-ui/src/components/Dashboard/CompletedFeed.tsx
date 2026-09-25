/**
 * Completed: a flat feed of work that finished, newest first.
 *
 * Every row here completed, so no row says so — a status column that repeats
 * one word down the whole feed is noise. Failures are not listed: they are in
 * "Needs attention", where someone can act on them. Cancelled and skipped runs
 * are bookkeeping and are listed nowhere.
 *
 * A row is its type, its title and, when the run recorded one, what it
 * actually produced — "2 issues found: …" for a review. "Completed
 * successfully" is not a detail and is never printed. Only reviews carry a
 * score, and a review always shows it: it is the result of the review.
 *
 * The feed is not windowed by date. Newest first already puts recent work on
 * top, so the heading carries a title filter instead of a period toggle.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { getDashboardOutcomes, type DashboardOutcomesResponse, type OutcomeItem } from '../../api/dashboardApi';
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
import { splitWorkTitle } from './workTitle';

/** Completions read per request. */
const FETCH_LIMIT = 50;
const VISIBLE_ITEMS = 8;

/** Rows drawn rather than folded behind a toggle, as in "Happening now". */
const OVERFLOW_SLACK = 1;

/** How long typing has to pause before the filter reads again. */
const SEARCH_DEBOUNCE_MS = 300;

const CompletedRow: React.FC<{ item: OutcomeItem }> = ({ item }) => {
  const work = splitWorkTitle(item.title, item.taskType);
  const title = work.title || 'Untitled work';
  return (
    <li>
      <RowLink
        href={workHref(item)}
        className="flex min-w-0 items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
      >
        <span className="min-w-0 flex-1">
          <RowMetaLines
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
          <RowTitle type={work.type}>{title}</RowTitle>
          {item.detail && item.detail !== title && <RowDetail>{item.detail}</RowDetail>}
        </span>
        {/*
          A review's score, and nothing else's. Rendered only when one exists,
          so no empty column is reserved.

          The scale is carried by the shape and by the assistive-technology
          label, never as visible `/10` prose: floating prose next to a
          fixed-width badge puts variable-width glyphs outside the w-12 box and
          makes the right rail shift by a pixel or two between 7, 8 and 9.
        */}
        {item.score !== null && item.score !== undefined && (
          <span className="flex flex-none items-baseline self-center sm:mt-0.5 sm:self-start" data-testid="completed-score">
            <ScoreBadge score={item.score} bracketed label="Review Score" />
            <span className="sr-only">Review score {item.score} out of 10</span>
          </span>
        )}
      </RowLink>
    </li>
  );
};

/** The title filter in the pane header. */
const TitleFilter: React.FC<{ value: string; onChange: (value: string) => void }> = ({ value, onChange }) => (
  <label className="relative flex items-center">
    <span className="sr-only">Filter completed work by title</span>
    <Search className="pointer-events-none absolute left-2 h-3 w-3 text-slate-400" aria-hidden="true" />
    <input
      type="search"
      data-testid="completed-filter"
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder="Filter by title"
      maxLength={200}
      className="h-7 w-40 rounded-sm border border-slate-200 bg-white pl-6 pr-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 sm:w-56"
    />
  </label>
);

export const CompletedFeed: React.FC<DashboardSectionProps> = ({ repository, refreshToken }) => {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const term = query.trim();
    const timer = window.setTimeout(() => { setSearch(term); setShowAll(false); }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(() => getDashboardOutcomes(repository, FETCH_LIMIT, search), [repository, search]);
  const { data, error, loading, reload } = useDashboardSection<DashboardOutcomesResponse>(
    load,
    `${repository}::${search}`,
    refreshToken,
  );
  // "5 mins ago" advances between reads.
  useNowTick(60_000);

  const items = data?.items ?? [];
  const canCollapse = items.length > VISIBLE_ITEMS + OVERFLOW_SLACK;
  const overflowCount = canCollapse ? items.length - VISIBLE_ITEMS : 0;
  const visible = showAll || !canCollapse ? items : items.slice(0, VISIBLE_ITEMS);

  const body = () => {
    if (loading) return <SectionSkeleton rows={4} />;
    if (error && items.length === 0) {
      return <SectionError message="Unable to load completed work" onRetry={reload} />;
    }
    if (items.length === 0) {
      return <SectionEmpty>{search ? `No completed work matches “${search}”` : 'Nothing completed yet'}</SectionEmpty>;
    }
    return (
      <>
        <ul data-testid="completed-list">
          {visible.map(item => (
            <CompletedRow key={item.id} item={item} />
          ))}
        </ul>
        {/*
          The expand control closes the pane as a footer bar rather than
          floating as a centred link in the white space under the last row.
        */}
        {overflowCount > 0 && (
          <SectionFooter data-testid="completed-footer">
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
      aria-labelledby="completed-heading"
      data-testid="completed-section"
      className="min-w-0 bg-white"
    >
      <SectionHeading id="completed-heading" title="Completed">
        <TitleFilter value={query} onChange={setQuery} />
      </SectionHeading>
      {body()}
    </section>
  );
};

export default CompletedFeed;
