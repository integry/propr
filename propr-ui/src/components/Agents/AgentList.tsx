import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Plus, Workflow } from 'lucide-react';
import type { AutomationRunState, InstanceCatalogAgent } from '@propr/shared';
import type { AutomationDefinitionRecord } from '../../api/automationDefinitionsApi';
import { ListPageHeader } from '../ListPageHeader';
import { RepositorySelector, type RepoOption } from '../RepositorySelector';
import { useDecoratedRepoOptions } from '../../hooks/useDecoratedRepoOptions';
import { useListSearchParams } from '../TaskList/hooks';
import { ListSkeleton } from '../ui/Skeleton';
import { CodeChip } from '../ui/CodeChip';
import { RepositoryChip } from '../ui/RepositoryChip';
import { CreatorMarker } from '../CreatorMarker';
import {
  AUTONOMY_BADGE_CLASSES,
  AUTONOMY_LABELS,
  runnerLabel,
  scheduleSummary,
  scheduleTooltip,
} from './agentPresentation';
import { AgentRunStateBadge } from './AgentRunStateBadge';
import { AgentTemplateLinks } from './AgentTemplates';
import {
  AUTOMATION_REPOSITORY_PARAM,
  AUTOMATION_SEARCH_MAX_LENGTH,
  AUTOMATION_SEARCH_PARAM,
  automationListQuery,
} from './automationListQuery';

interface AgentListProps {
  definitions: AutomationDefinitionRecord[] | null;
  /** Latest run state per agent id; agents without a run are absent. */
  lastRunStates: Record<string, AutomationRunState>;
  error: string | null;
  selectedId: string | null;
  /** Disables the empty state's "New automation" (demo mode). */
  readOnly?: boolean;
  /** Reference time for the "next in" summaries. */
  now?: number;
  /** The instance's configured agents, to name an agent picked without a model. */
  agents?: readonly InstanceCatalogAgent[];
  /** The new-automation form is open beside the list and offers the templates itself. */
  creating?: boolean;
  /**
   * The list fills the page (no automation open beside it), so from `sm` up its
   * rows take the header's inset and line up with the title and its right edge.
   */
  fullWidth?: boolean;
}

const MAX_REPO_CHIPS = 3;

const ALL_REPOSITORIES = 'all';

/** The list shows each automation's name only, so that is what the search reads; every word has to match. */
const matchesSearch = (definition: AutomationDefinitionRecord, terms: readonly string[]): boolean => {
  const name = definition.name.toLowerCase();
  return terms.every(term => name.includes(term));
};

/** An automation without repositories is listed only under "All Repos". */
const matchesRepository = (definition: AutomationDefinitionRecord, repository: string): boolean =>
  repository === ALL_REPOSITORIES || definition.repositories.includes(repository);

/** One sentence for whichever filter emptied the list, narrowest first. */
const emptyListReason = (search: string, repository: string): string =>
  search ? `No automations match “${search}”` : `No automations in ${repository}`;

/** "All Repos" plus every repository an automation runs in, with how many automations run there. */
const repositoryOptionsFor = (definitions: readonly AutomationDefinitionRecord[], selected: string): RepoOption[] => {
  const counts = new Map<string, number>();
  definitions.forEach(definition => definition.repositories.forEach(repository => counts.set(repository, (counts.get(repository) ?? 0) + 1)));
  // A repository from a link that no automation runs in stays selectable, so the filter shows what it holds.
  if (selected !== ALL_REPOSITORIES && !counts.has(selected)) counts.set(selected, 0);
  return [
    { name: ALL_REPOSITORIES, enabled: true, displayName: 'All Repos', count: definitions.length },
    ...Array.from(counts, ([name, count]) => ({ name, enabled: true, count }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  ];
};

/**
 * The list's repository and search filters, kept in the URL like the Goals and
 * Plans lists so Back and a reload restore them. The field follows typing at
 * once; the URL, and with it the filtered list, follow one debounce behind.
 */
function useAutomationListFilters() {
  const [searchParams, setSearchParams] = useListSearchParams();
  const repository = searchParams.get(AUTOMATION_REPOSITORY_PARAM) || ALL_REPOSITORIES;
  const search = (searchParams.get(AUTOMATION_SEARCH_PARAM) || '').slice(0, AUTOMATION_SEARCH_MAX_LENGTH).trim();
  const [searchQuery, setSearchQuery] = useState(search);
  // The search last written to (or read from) the URL; a different one arriving is Back, Forward or a link.
  const committedSearch = useRef(search);
  useEffect(() => {
    if (search === committedSearch.current) return;
    committedSearch.current = search;
    setSearchQuery(search);
  }, [search]);

  const updateParams = useCallback((updates: Record<string, string | null>) => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      Object.entries(updates).forEach(([key, value]) => {
        // "All Repos" is the repository selector's sentinel; a search for "all" is a search.
        if (!value || (key === AUTOMATION_REPOSITORY_PARAM && value === ALL_REPOSITORIES)) next.delete(key);
        else next.set(key, value);
      });
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const commitSearch = useCallback((value: string) => {
    committedSearch.current = value.trim();
    updateParams({ [AUTOMATION_SEARCH_PARAM]: value.trim() || null });
  }, [updateParams]);
  // Debounced against what the URL holds, not against the last debounced value:
  // the clear buttons commit at once, so re-entering the previous query right
  // after clearing still differs from the URL and has to be written.
  useEffect(() => {
    if (searchQuery.trim() === committedSearch.current) return;
    const timer = setTimeout(() => commitSearch(searchQuery), 400);
    return () => clearTimeout(timer);
  }, [searchQuery, commitSearch]);

  const setRepository = useCallback((value: string) => updateParams({ [AUTOMATION_REPOSITORY_PARAM]: value }), [updateParams]);
  const clearSearch = useCallback(() => {
    setSearchQuery('');
    commitSearch('');
  }, [commitSearch]);
  const clearFilters = useCallback(() => {
    setSearchQuery('');
    committedSearch.current = '';
    updateParams({ [AUTOMATION_REPOSITORY_PARAM]: null, [AUTOMATION_SEARCH_PARAM]: null });
  }, [updateParams]);

  return {
    repository, search, searchQuery, setSearchQuery, setRepository, clearSearch, clearFilters,
    listQuery: automationListQuery(searchParams),
  };
}

const AgentRow: React.FC<{ definition: AutomationDefinitionRecord; lastRunState?: AutomationRunState; selected: boolean; now: number; agents: readonly InstanceCatalogAgent[]; listQuery: string; fullWidth: boolean }> = ({
  definition, lastRunState, selected, now, agents, listQuery, fullWidth,
}) => {
  const extraRepos = definition.repositories.length - MAX_REPO_CHIPS;
  return (
    <li>
      <Link
        to={`/automations/${encodeURIComponent(definition.id)}${listQuery}`}
        aria-current={selected ? 'page' : undefined}
        data-testid="agent-row"
        className={`block border-b border-slate-100 px-4 py-2.5 ${fullWidth ? 'sm:px-6' : ''} focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 ${selected ? 'bg-teal-50/60 shadow-[inset_2px_0_0_0_#0d9488]' : 'hover:bg-slate-50'}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-slate-900">{definition.name}</span>
            <span className={`flex-none rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${AUTONOMY_BADGE_CLASSES[definition.autonomyMode]}`}>
              {AUTONOMY_LABELS[definition.autonomyMode]}
            </span>
            {!definition.enabled && <span className="flex-none text-[10px] font-bold uppercase tracking-wider text-slate-400">Disabled</span>}
          </div>
          {lastRunState
            ? <AgentRunStateBadge state={lastRunState} attention data-testid="agent-last-run" />
            : <span className="flex-none text-xs text-slate-400" data-testid="agent-last-run">Never run</span>}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-slate-500">
          {definition.repositories.slice(0, MAX_REPO_CHIPS).map(repository => (
            <RepositoryChip key={repository} repository={repository} />
          ))}
          {extraRepos > 0 && <span>+{extraRepos}</span>}
          <CodeChip>{runnerLabel(definition, agents)}</CodeChip>
          <span className="inline-flex items-center gap-1" title={scheduleTooltip(definition) ?? undefined} data-testid="agent-schedule-summary"><Clock className="h-3 w-3" aria-hidden="true" />{scheduleSummary(definition, now)}</span>
          <CreatorMarker creator={definition.createdBy} />
        </div>
      </Link>
    </li>
  );
};

/** The saved agents, filterable by repository and searchable, with a launchpad empty state when there are none. */
const NO_AGENTS: readonly InstanceCatalogAgent[] = [];

/** How often the list's own clock moves on, so "next in …" stays current on a page left open. */
const LIST_CLOCK_MS = 60_000;

/**
 * The current time, moved on every LIST_CLOCK_MS. The list keeps its own clock
 * rather than relying on the page re-rendering it, because the page must not
 * re-render (and so disturb) the automation or run open beside the list.
 */
function useListClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), LIST_CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export const AgentList: React.FC<AgentListProps> = ({
  definitions, lastRunStates, error, selectedId, readOnly = false, now: fixedNow, agents = NO_AGENTS, creating = false, fullWidth = false,
}) => {
  const clock = useListClock();
  const now = fixedNow ?? clock;
  const filters = useAutomationListFilters();
  const { repository, search, listQuery } = filters;
  const visible = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    return definitions?.filter(definition => matchesRepository(definition, repository) && matchesSearch(definition, terms)) ?? [];
  }, [definitions, repository, search]);
  const repositoryOptions = useDecoratedRepoOptions(useMemo(
    () => repositoryOptionsFor(definitions ?? [], repository),
    [definitions, repository],
  ));

  const newAgent = (
    <Link
      to="/automations/new"
      aria-disabled={readOnly}
      onClick={event => { if (readOnly) event.preventDefault(); }}
      className={`inline-flex flex-none items-center gap-1.5 rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${readOnly ? 'pointer-events-none opacity-50' : ''}`}
    >
      <Plus className="h-4 w-4" aria-hidden="true" />New automation
    </Link>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <ListPageHeader
        title="Automations"
        titleId="automations-title"
        showControls={(definitions?.length ?? 0) > 0}
        search={{
          value: filters.searchQuery,
          onChange: filters.setSearchQuery,
          onClear: filters.clearSearch,
          label: 'Search automations',
          maxLength: AUTOMATION_SEARCH_MAX_LENGTH,
        }}
        filters={
          <div role="group" aria-label="Filter automations by repository" className="min-w-0 max-w-[220px] flex-1 sm:max-w-[320px]">
            <RepositorySelector
              repos={repositoryOptions}
              selectedRepo={repository}
              onRepoChange={filters.setRepository}
              labelLayout="stacked"
              className="w-full min-w-0"
            />
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="px-4 py-6 text-sm text-red-700">{error}</p>
        ) : definitions === null ? (
          <ListSkeleton layout="row" rows={5} label="Loading automations…" className="p-4" />
        ) : definitions.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <Workflow className="h-10 w-10 text-slate-300" strokeWidth={1.5} aria-hidden="true" />
            <h2 className="mt-4 text-base font-semibold text-slate-900">No automations yet</h2>
            <p className="mt-2 max-w-md text-sm text-slate-500">A saved prompt that runs on a schedule or on demand and writes a report.</p>
            {!creating && (
              <>
                <div className="mt-5">{newAgent}</div>
                <AgentTemplateLinks readOnly={readOnly} />
              </>
            )}
          </div>
        ) : visible.length === 0 ? (
          <div className="border-b border-dashed border-slate-300 px-4 py-10 text-center" data-testid="agents-filtered-empty">
            <p className="text-sm font-medium text-slate-700">{emptyListReason(search, repository)}</p>
            <button type="button" onClick={filters.clearFilters} className="mt-2 text-sm font-medium text-teal-700 hover:underline">Clear filters</button>
          </div>
        ) : (
          <ul aria-label="Automations">
            {visible.map(definition => (
              <AgentRow
                key={definition.id}
                definition={definition}
                lastRunState={lastRunStates[definition.id]}
                selected={definition.id === selectedId}
                now={now}
                agents={agents}
                listQuery={listQuery}
                fullWidth={fullWidth}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default AgentList;
