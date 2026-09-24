/**
 * Happening now: the operational view of work in flight.
 *
 * Rows show only facts the system actually has — lifecycle phase, elapsed time
 * and the latest progress line the agent reported. There is no synthesised
 * percentage, and a run with no recent chat message is not called stalled:
 * missing progress means the progress is unknown, not that the work is stuck.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getDashboardActive, type ActiveItem, type DashboardActiveResponse } from '../../api/dashboardApi';
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
  SectionLink,
  SectionSkeleton,
  WorkReference,
} from './sectionPrimitives';
import {
  type DashboardSectionProps,
  elapsedRunning,
  filteredTasksHref,
  primaryClause,
  shortenPaths,
  useDashboardSection,
  useNowTick,
  useStableOrder,
  workHref,
} from './sectionState';

/** Active rows shown before the list has to be expanded. */
const VISIBLE_ITEMS = 5;

/**
 * Rows the list will simply draw rather than fold behind a control.
 *
 * A "Show 1 more" toggle costs a line of chrome to save a line of content and
 * asks for a click to reveal a single row. Past the slack the toggle earns its
 * place; at or below it the row is just shown.
 */
const OVERFLOW_SLACK = 1;

const itemKey = (item: ActiveItem): string => item.id;

const itemTitle = (item: ActiveItem): string =>
  item.title || (item.prNumber ? `Pull request #${item.prNumber}` : item.issueNumber ? `Issue #${item.issueNumber}` : 'Untitled work');

/**
 * One running row: the whole row is the link to the work it names.
 *
 * There is no disclosure chevron. A chevron on the edge of a feed row promises
 * an accordion, and this row does not open one — clicking it navigates to the
 * task, which is where the phase history, the timings and the full progress
 * line already live. Drawing both a link and a fold made the row claim two
 * different behaviours, and on a phone the arrow also sat two pixels from the
 * elapsed time it was crowding. The row has one behaviour and the space back.
 */
const ActiveRow: React.FC<{ item: ActiveItem }> = ({ item }) => (
  <li>
    <RowLink href={workHref(item)} className="block min-w-0 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500">
      <RowMetaLines
        /*
          A spinner, not a dot: a filled circle reads as a status light, and a
          green one reads as "done". Motion is unambiguous about work in flight.
        */
        status={(
          <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-teal-700">
            <Loader2 className="h-3 w-3 flex-none animate-spin" aria-hidden="true" />
            <span className="truncate">{item.phase || 'Running'}</span>
          </span>
        )}
        entities={(
          <>
            <RepositoryLabel repository={item.repository} />
            <WorkReference issueNumber={item.issueNumber} prNumber={item.prNumber} />
          </>
        )}
        trailing={(
          <span title={`Started ${new Date(item.createdAt).toLocaleString()}`}>
            {elapsedRunning(item.createdAt)}
          </span>
        )}
      />
      <RowTitle>{itemTitle(item)}</RowTitle>
      {/*
        The progress line is a sentence with a repository path in it, and on a
        phone the path is most of the sentence: 110 characters of
        `propr-ui/src/components/…` wrapped to three lines of the densest text
        on the screen. Someone triaging on a phone needs the file, not the
        route to it, so the directories collapse below `sm` and come back
        whole where there is width for them — and the sentence stops at its
        first clause rather than being cut mid-word by the clamp.
      */}
      {item.progressLine && (
        <RowDetail>
          <span className="sm:hidden">{shortenPaths(primaryClause(item.progressLine))}</span>
          <span className="hidden sm:inline">{item.progressLine}</span>
        </RowDetail>
      )}
    </RowLink>
  </li>
);

/**
 * The one footer under the running list.
 *
 * Waiting work is summarised rather than listed, and the control that unfolds
 * the rest of the list rides in the same bar. Two pieces of after-the-list
 * chrome — a floating link above a tinted strip — read as an accident; one bar
 * reads as the end of the pane.
 */
const HappeningNowFooter: React.FC<{
  queuedCount: number;
  reason: string | null;
  repository: string;
  overflowCount: number;
  expanded: boolean;
  onToggle: () => void;
}> = ({ queuedCount, reason, repository, overflowCount, expanded, onToggle }) => {
  const showToggle = overflowCount > 0;
  if (queuedCount === 0 && !showToggle) return null;
  return (
    <SectionFooter data-testid="happening-now-footer">
      {queuedCount > 0 && (
        <span data-testid="queue-summary" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`font-medium text-slate-700 ${reason ? 'border-r border-slate-300 pr-2' : ''}`}>
            {queuedCount} queued
          </span>
          {reason && <span>{reason}</span>}
        </span>
      )}
      <span className="ml-auto flex items-center gap-x-3">
        {showToggle && (
          <SectionFooterButton expanded={expanded} onClick={onToggle}>
            {expanded ? 'Show fewer' : `Show ${overflowCount} more`}
          </SectionFooterButton>
        )}
        {queuedCount > 0 && (
          <SectionLink to={filteredTasksHref('waiting', repository)}>View queue</SectionLink>
        )}
      </span>
    </SectionFooter>
  );
};

export const HappeningNowSection: React.FC<DashboardSectionProps> = ({ repository, refreshToken }) => {
  const load = useCallback(() => getDashboardActive(repository), [repository]);
  const { data, error, loading, reload } = useDashboardSection<DashboardActiveResponse>(
    load,
    repository,
    refreshToken,
  );
  const [showAll, setShowAll] = useState(false);
  // Elapsed times advance between reads.
  useNowTick();

  const running = useMemo(() => data?.running ?? [], [data]);
  const orderedRunning = useStableOrder(running, itemKey);
  // One row over the limit is drawn, not folded: see OVERFLOW_SLACK.
  const canCollapse = orderedRunning.length > VISIBLE_ITEMS + OVERFLOW_SLACK;
  const collapsedLimit = canCollapse ? VISIBLE_ITEMS : orderedRunning.length;
  const overflowCount = canCollapse ? orderedRunning.length - VISIBLE_ITEMS : 0;

  const heading = (
    <SectionHeading id="happening-now-heading" title="Happening now" count={data?.counts.running ?? null}>
      <SectionLink to={filteredTasksHref('active', repository)}>View all</SectionLink>
    </SectionHeading>
  );

  const body = () => {
    if (loading) return <SectionSkeleton rows={3} />;
    // "We could not find out" is not the same as "nothing is running", so the
    // failed read keeps its own wording and its own retry.
    if (error && orderedRunning.length === 0) {
      return <SectionError message="Unable to load running work" onRetry={reload} />;
    }
    if (orderedRunning.length === 0) {
      return <SectionEmpty>No work running</SectionEmpty>;
    }

    const visible = showAll ? orderedRunning : orderedRunning.slice(0, collapsedLimit);
    return (
      <ul data-testid="happening-now-list">
        {visible.map(item => (
          <ActiveRow key={item.id} item={item} />
        ))}
      </ul>
    );
  };

  /*
    The pane is a column with a floor, not a stack that stops where its rows
    do. Its height is set by whichever pane is taller in the row, so a single
    running task beside three attention items left the queue bar stranded
    mid-pane above a band of white. The list area takes the slack instead, and
    the footer closes the pane against the rule under it.
  */
  return (
    <section
      aria-labelledby="happening-now-heading"
      data-testid="happening-now-section"
      className="flex h-full min-w-0 flex-col bg-white"
    >
      {heading}
      <div className="flex-1">{body()}</div>
      {data && (
        <HappeningNowFooter
          queuedCount={data.queue.queuedCount}
          reason={data.queue.reason}
          repository={repository}
          overflowCount={overflowCount}
          expanded={showAll}
          onToggle={() => setShowAll(value => !value)}
        />
      )}
    </section>
  );
};

export default HappeningNowSection;
