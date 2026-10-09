import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Plus, Workflow } from 'lucide-react';
import type { AgentRunState, InstanceCatalogAgent } from '@propr/shared';
import type { AgentDefinitionRecord } from '../../api/agentDefinitionsApi';
import { ListSearchInput } from '../ListSearchInput';
import { ListSkeleton } from '../ui/Skeleton';
import { CodeChip } from '../ui/CodeChip';
import { CreatorMarker } from '../CreatorMarker';
import {
  AUTONOMY_BADGE_CLASSES,
  AUTONOMY_LABELS,
  repoShortName,
  runnerLabel,
  scheduleSummary,
} from './agentPresentation';
import { AgentRunStateBadge } from './AgentRunStateBadge';

interface AgentListProps {
  definitions: AgentDefinitionRecord[] | null;
  /** Latest run state per agent id; agents without a run are absent. */
  lastRunStates: Record<string, AgentRunState>;
  error: string | null;
  selectedId: string | null;
  /** Disables the empty state's "New automation" (demo mode). */
  readOnly?: boolean;
  /** Reference time for the "next in" summaries. */
  now?: number;
  /** The instance's configured agents, to name an agent picked without a model. */
  agents?: readonly InstanceCatalogAgent[];
}

const MAX_REPO_CHIPS = 3;

const matches = (definition: AgentDefinitionRecord, query: string, agents: readonly InstanceCatalogAgent[]): boolean => {
  if (!query) return true;
  const haystack = [definition.name, definition.description ?? '', runnerLabel(definition, agents), ...definition.repositories]
    .join(' ')
    .toLowerCase();
  return query.toLowerCase().split(/\s+/).every(term => haystack.includes(term));
};

const AgentRow: React.FC<{ definition: AgentDefinitionRecord; lastRunState?: AgentRunState; selected: boolean; now: number; agents: readonly InstanceCatalogAgent[] }> = ({
  definition, lastRunState, selected, now, agents,
}) => {
  const extraRepos = definition.repositories.length - MAX_REPO_CHIPS;
  return (
    <li>
      <Link
        to={`/automations/${encodeURIComponent(definition.id)}`}
        aria-current={selected ? 'page' : undefined}
        data-testid="agent-row"
        className={`block border-b border-slate-100 px-4 py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 ${selected ? 'bg-teal-50/60 shadow-[inset_2px_0_0_0_#0d9488]' : 'hover:bg-slate-50'}`}
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
            <CodeChip key={repository} title={repository}>{repoShortName(repository)}</CodeChip>
          ))}
          {extraRepos > 0 && <span>+{extraRepos}</span>}
          <CodeChip>{runnerLabel(definition, agents)}</CodeChip>
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden="true" />{scheduleSummary(definition, now)}</span>
          <CreatorMarker creator={definition.createdBy} />
        </div>
      </Link>
    </li>
  );
};

/** The saved agents, searchable, with a launchpad empty state when there are none. */
const NO_AGENTS: readonly InstanceCatalogAgent[] = [];

export const AgentList: React.FC<AgentListProps> = ({ definitions, lastRunStates, error, selectedId, readOnly = false, now = Date.now(), agents = NO_AGENTS }) => {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => definitions?.filter(definition => matches(definition, query.trim(), agents)) ?? [], [agents, definitions, query]);

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
      <header className="flex flex-none items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <h1 className="text-base font-semibold text-slate-900">Automations</h1>
        <ListSearchInput value={query} onChange={setQuery} onClear={() => setQuery('')} label="Search automations" className="min-w-0 flex-1" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="px-4 py-6 text-sm text-red-700">{error}</p>
        ) : definitions === null ? (
          <ListSkeleton layout="row" rows={5} label="Loading automations…" className="p-4" />
        ) : definitions.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <Workflow className="h-10 w-10 text-slate-300" strokeWidth={1.5} aria-hidden="true" />
            <h2 className="mt-4 text-base font-semibold text-slate-900">No automations yet</h2>
            <p className="mt-2 max-w-md text-sm text-slate-500">
              An automation is a saved prompt that a coding agent runs on demand or on a schedule against your repositories, writing a report.
              It can stop there, wait for your approval, or act on the report through ProPR tools.
            </p>
            <div className="mt-5">{newAgent}</div>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            No automations match “{query.trim()}”. <button type="button" onClick={() => setQuery('')} className="text-teal-700 hover:underline">Clear search</button>
          </p>
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
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default AgentList;
