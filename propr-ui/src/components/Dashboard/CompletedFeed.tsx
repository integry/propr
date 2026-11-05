/**
 * Completed: one row per entity, showing its newest successful outcome.
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

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { getDashboardOutcomes, getDashboardOutcomeHistory, OutcomeHistoryStaleError, type DashboardOutcomesResponse, type OutcomeItem } from '../../api/dashboardApi';
import { getAuthenticatedApiReadScopeGeneration } from '../../api/apiClient';
import { ScoreBadge } from '../TaskList/ScoreBadge';
import {
  RepositoryLabel,
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
  WorkTypeBadge,
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
const VISIBLE_ITEMS = 5;

/** How long typing has to pause before the filter reads again. */
const SEARCH_DEBOUNCE_MS = 300;

// Recorded run metadata takes precedence over the task's mutable title.
const RECORDED_WORK_TYPES: Record<string, string> = { review: 'Review', fix: 'Fix', 'follow-up': 'Follow-up', merge: 'Merge' };

/** Compact only the structured review prefix; retain the actual findings verbatim. */
function compactDelta(detail: string): string {
  const summary = detail.replace(/\s+/g, ' ').trim();
  const findings = /^(?:([0-9]+) issues? found|Found ([0-9]+) issues?):\s*(.+)$/i.exec(summary);
  if (!findings) return summary;
  const count = findings[1] ?? findings[2];
  return `${findings[3].replace(/;\s+/g, ' & ')} (${count} ${count === '1' ? 'issue' : 'issues'})`;
}

function updateType(update: OutcomeItem, type: string | null): string {
  const detail = update.detail ?? '';
  // Some older runs record only "pr-comment" or "Follow-up" as their type.
  // Prefer explicit review evidence, then validation-only recaps. A fix that
  // merely mentions passing validation must remain a fix.
  if (update.taskType === 'review' || type === 'Review' || update.score != null || /^Review\b/i.test(detail)) return 'Review';
  if (/^(?:validation|verification|validate|verify)$/i.test(type ?? '')
    || (/\bno (?:further )?changes\b/i.test(detail) && /\b(?:verified|lint passed|tests? passed)\b/i.test(detail))) return 'Verify';
  if (/^ci(?: checks?)?$/i.test(type ?? '') || /^CI checks? (?:passed|completed)\b/i.test(detail)) return 'CI';
  if ((type === 'Follow-up' || type === 'PR comment') && /^(?:Fixed|Implemented|Applied|Repaired|Removed)\b/i.test(detail)) return 'Fix';
  return type ?? 'Task';
}

function compactElapsedLabel(at: string): string {
  return elapsedLabel(at)
    .replace('less than a minute', '<1m')
    .replace(/ mins?$/, 'm')
    .replace(/ hrs?$/, 'h')
    .replace(/ days?$/, 'd');
}

/** Pages belong to an entity revision and authenticated connection, never a task ID alone. */
function useOutcomeHistory(item: OutcomeItem, expanded: boolean, onStale: () => void) {
  const scope = getAuthenticatedApiReadScopeGeneration();
  const key = JSON.stringify([scope, item.repository, item.entityId, item.revision]);
  const empty = { key, items: [] as OutcomeItem[], nextCursor: null as string | null, loaded: false };
  const cache = useRef(empty);
  if (cache.current.key !== key) cache.current = empty;
  const [view, setView] = useState({ ...empty, loading: false, error: '' });
  const sequence = useRef(0);
  const activeKey = useRef(key);
  activeKey.current = key;
  const { repository, entityId, revision } = item;
  const loadPage = useCallback(async (more = false) => {
    if (!entityId || !revision) return;
    const cursor = more ? cache.current.nextCursor : null;
    if (more && !cursor) return;
    const request = ++sequence.current;
    setView({ ...cache.current, loading: true, error: '' });
    try {
      const page = await getDashboardOutcomeHistory(repository, entityId, revision, cursor);
      if (request !== sequence.current || activeKey.current !== key || scope !== getAuthenticatedApiReadScopeGeneration()) return;
      cache.current = { key, items: more ? [...cache.current.items, ...page.items] : page.items,
        nextCursor: page.nextCursor, loaded: true };
      setView({ ...cache.current, loading: false, error: '' });
    } catch (error) {
      if (request !== sequence.current || activeKey.current !== key || scope !== getAuthenticatedApiReadScopeGeneration()) return;
      if (error instanceof OutcomeHistoryStaleError) {
        cache.current = { key, items: [], nextCursor: null, loaded: false };
        onStale();
      }
      setView({ ...cache.current, loading: false,
        error: error instanceof OutcomeHistoryStaleError ? error.message : 'Unable to load earlier updates' });
    }
  }, [key, scope, repository, entityId, revision, onStale]);
  useEffect(() => {
    if (expanded) {
      if (!cache.current.loaded) void loadPage();
      else setView({ ...cache.current, loading: false, error: '' });
    }
    return () => { sequence.current += 1; };
  }, [expanded, loadPage]);
  return { ...(view.key === key ? view : { ...empty, loading: expanded, error: '' }),
    loadMore: () => void loadPage(true), retry: () => void loadPage(cache.current.loaded) };
}

function EarlierUpdates({ item, title, updates, history }: {
  item: OutcomeItem;
  title: string;
  updates: OutcomeItem[];
  history: ReturnType<typeof useOutcomeHistory>;
}) {
  return (
    <>
      {history.loading && <li role="status" className="text-xs text-slate-500">Loading earlier updates…</li>}
      {history.error && <li className="text-xs text-slate-600" role="alert">
        {history.error} <button type="button" onClick={history.retry} className="underline">Retry</button>
      </li>}
      {item.entityId && history.loaded && !history.loading && !history.error && updates.length === 0
        && <li className="text-xs text-slate-500">No earlier updates</li>}
      {updates.map(update => {
        const updateWork = splitWorkTitle(update.title, update.taskType);
        const type = updateType(update, RECORDED_WORK_TYPES[update.taskType ?? ''] ?? updateWork.type);
        // A missing recap is a run type, never the parent deliverable again.
        const delta = update.detail && update.detail !== title && update.detail !== item.title
          && update.detail !== update.title && update.detail !== updateWork.title
          ? update.detail : `${type} run`;
        return (
          <li key={update.id}>
            <RowLink href={workHref(update)} className="grid min-w-0 grid-cols-[3.5rem_5rem_minmax(0,1fr)_3rem] items-center gap-x-2 rounded-sm py-0.5 text-xs leading-5 text-slate-600 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">
              <time dateTime={update.occurredAt} title={new Date(update.occurredAt).toLocaleString()} className="whitespace-nowrap font-mono text-[11px] tabular-nums text-slate-400">{compactElapsedLabel(update.occurredAt)} ago</time>
              <WorkTypeBadge type={type} compact />
              <span className="min-w-0 truncate text-slate-700" title={delta}>{compactDelta(delta)}</span>
              <span className="w-12 text-right">
                {update.score !== null && update.score !== undefined && (
                  <>
                    <ScoreBadge score={update.score} bracketed label="Review Score" />
                    <span className="sr-only">Review score {update.score} out of 10</span>
                  </>
                )}
              </span>
            </RowLink>
          </li>
        );
      })}
      {history.nextCursor && !history.error && <li>
        <button type="button" onClick={history.loadMore} disabled={history.loading}
          className="text-xs text-slate-600 underline disabled:opacity-50">Load more updates</button>
      </li>}
    </>
  );
}

function OutcomeDetail({ item, title, earlierCount, expanded, updatesId, onToggle }: {
  item: OutcomeItem;
  title: string;
  earlierCount: number;
  expanded: boolean;
  updatesId: string;
  onToggle: () => void;
}) {
  if (!(earlierCount > 0 || (item.detail && item.detail !== title))) return null;
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-2 px-3 text-xs leading-5 text-slate-500">
      {earlierCount > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={updatesId}
          onClick={onToggle}
          className="flex-none rounded-sm hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
        >
          <span aria-hidden="true">{expanded ? '▾' : '↳'} </span>
          {expanded ? 'Hide ' : ''}{earlierCount} earlier {earlierCount === 1 ? 'update' : 'updates'}
        </button>
      )}
      {item.detail && item.detail !== title && (
        <span className="min-w-0 truncate" title={item.detail}>
          {earlierCount > 0 && <span aria-hidden="true">· </span>}{item.detail}
        </span>
      )}
    </div>
  );
}

const CompletedRow: React.FC<{ item: OutcomeItem; onStale: () => void }> = ({ item, onStale }) => {
  const [expanded, setExpanded] = useState(false);
  const updatesId = useId();
  const history = useOutcomeHistory(item, expanded && Boolean(item.entityId) && (item.eventCount ?? 0) > 1, onStale);
  const updates = item.entityId ? history.items : item.earlierUpdates ?? [];
  const earlierCount = Math.max(0, (item.eventCount ?? (updates.length + 1)) - 1);
  const work = splitWorkTitle(item.title, item.taskType);
  const title = work.title || 'Untitled work';
  return (
    <li className="py-2.5">
      <RowLink
        href={workHref(item)}
        className="flex min-w-0 items-start gap-2 px-3 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
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
          <RowTitle type={RECORDED_WORK_TYPES[item.taskType ?? ''] ?? work.type}>{title}</RowTitle>
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
      <OutcomeDetail item={item} title={title} earlierCount={earlierCount} expanded={expanded}
        updatesId={updatesId} onToggle={() => setExpanded(value => !value)} />
      {earlierCount > 0 && (
        <ul id={updatesId} hidden={!expanded} className="ml-3 mr-3 my-2 space-y-1.5 border-l-2 border-solid border-slate-200 pl-3">
          {expanded && <EarlierUpdates item={item} title={title} updates={updates} history={history} />}
        </ul>
      )}
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

  const authScope = getAuthenticatedApiReadScopeGeneration();
  const load = useCallback(() => getDashboardOutcomes(repository, FETCH_LIMIT, search), [repository, search]);
  const { data, error, loading, reload } = useDashboardSection<DashboardOutcomesResponse>(
    load,
    `${authScope}::${repository}::${search}`,
    refreshToken,
  );
  // "5 mins ago" advances between reads.
  useNowTick(60_000);

  const items = data?.items ?? [];
  const canCollapse = items.length > VISIBLE_ITEMS;
  const overflowCount = canCollapse ? items.length - VISIBLE_ITEMS : 0;
  const visible = showAll || !canCollapse ? items : items.slice(0, VISIBLE_ITEMS);

  const body = () => {
    if (loading) return <SectionSkeleton rows={4} label="Loading completed work…" />;
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
            <CompletedRow key={`${authScope}:${repository}:${item.entityId ?? item.id}`} item={item} onStale={reload} />
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
