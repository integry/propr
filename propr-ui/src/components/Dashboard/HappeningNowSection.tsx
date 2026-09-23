/**
 * Happening now: the operational view of work in flight.
 *
 * Rows show only facts the system actually has — lifecycle phase, elapsed time
 * and the latest progress line the agent reported. There is no synthesised
 * percentage, and a run with no recent chat message is not called stalled:
 * missing progress means the progress is unknown, not that the work is stuck.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { getDashboardActive, type ActiveItem, type DashboardActiveResponse } from '../../api/dashboardApi';
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
  SectionLink,
  SectionSkeleton,
  WorkReference,
} from './sectionPrimitives';
import {
  type DashboardSectionProps,
  elapsedRunning,
  filteredTasksHref,
  useDashboardSection,
  useNowTick,
  useStableOrder,
  workHref,
} from './sectionState';

/** Active rows shown before the list has to be expanded. */
const VISIBLE_ITEMS = 5;

const itemKey = (item: ActiveItem): string => item.id;

const itemTitle = (item: ActiveItem): string =>
  item.title || (item.prNumber ? `Pull request #${item.prNumber}` : item.issueNumber ? `Issue #${item.issueNumber}` : 'Untitled work');

const ActiveRow: React.FC<{
  item: ActiveItem;
  expanded: boolean;
  onToggle: (id: string) => void;
}> = ({ item, expanded, onToggle }) => (
  <li className="border-b border-slate-100 last:border-b-0">
    <div className="flex min-w-0 items-start gap-1">
      <RowLink href={workHref(item)} className="block min-w-0 flex-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500">
        <RowMeta>
          <span className="inline-flex items-center gap-1.5 font-medium text-teal-700">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-500" aria-hidden="true" />
            {item.phase || 'Running'}
          </span>
          <Dot />
          <RepositoryLabel repository={item.repository} />
          <WorkReference issueNumber={item.issueNumber} prNumber={item.prNumber} />
          <Dot />
          <span className="whitespace-nowrap text-gray-500" title={`Started ${new Date(item.createdAt).toLocaleString()}`}>
            {elapsedRunning(item.createdAt)}
          </span>
        </RowMeta>
        <RowTitle>{itemTitle(item)}</RowTitle>
        {item.progressLine && <RowDetail clamp={!expanded}>{item.progressLine}</RowDetail>}
      </RowLink>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${itemTitle(item)}`}
        onClick={() => onToggle(item.id)}
        className="mt-1.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
    </div>
    {expanded && (
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 px-3 pb-3 text-xs text-slate-600">
        <dt className="text-gray-500">Phase</dt>
        <dd>{item.phase || 'Running'}</dd>
        <dt className="text-gray-500">Started</dt>
        <dd>{new Date(item.createdAt).toLocaleString()}</dd>
        <dt className="text-gray-500">Last update</dt>
        <dd>{new Date(item.updatedAt).toLocaleString()}</dd>
        <dt className="text-gray-500">Progress</dt>
        {/* An absent progress line is unknown progress, not a stall. */}
        <dd>{item.progressLine || 'No progress reported yet'}</dd>
      </dl>
    )}
  </li>
);

/** Waiting work, summarised rather than listed, with the real reason when known. */
const QueueSummary: React.FC<{ queuedCount: number; reason: string | null; repository: string }> = ({
  queuedCount,
  reason,
  repository,
}) => {
  if (queuedCount === 0) return null;
  return (
    <div
      data-testid="queue-summary"
      className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600"
    >
      <span className="font-medium text-slate-700">
        {queuedCount} queued
      </span>
      {reason && (
        <>
          <Dot />
          <span>{reason}</span>
        </>
      )}
      <span className="ml-auto">
        <SectionLink to={filteredTasksHref('waiting', repository)}>View queue</SectionLink>
      </span>
    </div>
  );
};

export const HappeningNowSection: React.FC<DashboardSectionProps> = ({ repository, refreshToken, onLoaded }) => {
  const load = useCallback(() => getDashboardActive(repository), [repository]);
  const { data, error, loading, reload } = useDashboardSection<DashboardActiveResponse>(
    load,
    repository,
    refreshToken,
    onLoaded,
  );
  const [showAll, setShowAll] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Elapsed times advance between reads.
  useNowTick();

  const running = useMemo(() => data?.running ?? [], [data]);
  const orderedRunning = useStableOrder(running, itemKey);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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

    const visible = showAll ? orderedRunning : orderedRunning.slice(0, VISIBLE_ITEMS);
    return (
      <>
        <ul data-testid="happening-now-list">
          {visible.map(item => (
            <ActiveRow
              key={item.id}
              item={item}
              expanded={expandedIds.has(item.id)}
              onToggle={toggleExpanded}
            />
          ))}
        </ul>
        {orderedRunning.length > VISIBLE_ITEMS && (
          <button
            type="button"
            onClick={() => setShowAll(value => !value)}
            className="mt-1 w-full rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            {showAll ? 'Show fewer' : `Show ${orderedRunning.length - VISIBLE_ITEMS} more`}
          </button>
        )}
      </>
    );
  };

  return (
    <section
      aria-labelledby="happening-now-heading"
      data-testid="happening-now-section"
      className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm"
    >
      {heading}
      {body()}
      {data && (
        <QueueSummary
          queuedCount={data.queue.queuedCount}
          reason={data.queue.reason}
          repository={repository}
        />
      )}
    </section>
  );
};

export default HappeningNowSection;
