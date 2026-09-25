import React from 'react';
import { LoaderCircle, ShieldAlert, Plug, TriangleAlert } from 'lucide-react';
import type { McpAccessLogEntry, McpAccessLogStats } from '../api/adminMcpLogsApi';
import {
  UNAVAILABLE,
  clientDisplayName,
  outcomeTone,
  type McpOutcomeLike,
  formatMcpBytes,
  formatMcpCount,
  formatMcpDuration,
  formatMcpTimestamp,
} from './mcpLogsUtils';

/**
 * Presentation for the MCP access log page. Colour here is the semantic set the
 * design guidelines already define: a completed call is quiet grey, a rejected
 * call is amber (a human has to look at it), and a failed call is red.
 */

export const OutcomeBadge: React.FC<{ outcome: McpOutcomeLike; status?: number | null }> = ({ outcome, status }) => {
  const tone = outcomeTone(outcome);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone.badge}`}
      title={typeof status === 'number' && Number.isFinite(status) ? `HTTP ${status}` : undefined}
    >
      {tone.label}
    </span>
  );
};

/** A monospace chip for a technical identifier, per the design guidelines. */
export const MonoChip: React.FC<{ value: string | null | undefined; title?: string }> = ({ value, title }) => {
  if (!value) return <span className="text-slate-400">{UNAVAILABLE}</span>;
  return (
    <span className="whitespace-nowrap rounded-sm bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-700" title={title ?? value}>
      {value}
    </span>
  );
};

const StatTile: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => (
  <div className="min-w-[5.5rem] px-3 first:pl-0">
    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
    <div className={`mt-0.5 text-sm font-medium tabular-nums ${tone ?? 'text-slate-900'}`}>{value}</div>
  </div>
);

const TopList: React.FC<{ label: string; entries: Array<{ key: string; label: string; count: number }> | null }> = ({ label, entries }) => (
  <div className="min-w-0 px-3 first:pl-0">
    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
    <div className="mt-1 flex flex-wrap gap-1">
      {entries === null && <span className="text-sm text-slate-400">{UNAVAILABLE}</span>}
      {entries?.length === 0 && <span className="text-sm text-slate-400">None</span>}
      {entries?.map(entry => (
        <span key={entry.key} className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
          {entry.label}
          <span className="ml-1 text-slate-500">{entry.count.toLocaleString()}</span>
        </span>
      ))}
    </div>
  </div>
);

/**
 * The window summary. Anything the stats endpoint did not report renders as
 * unavailable — an absent figure must never read as a zero.
 */
export const McpLogsStats: React.FC<{ stats: McpAccessLogStats | null; error: string | null; loading: boolean }> = ({ stats, error, loading }) => {
  if (error) {
    return (
      <div className="border-b border-gray-200 bg-white px-4 py-2 text-xs text-amber-800 sm:px-6" role="status">
        <TriangleAlert size={14} className="mr-1 inline align-text-bottom" aria-hidden="true" />
        Summary unavailable: {error}
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="border-b border-gray-200 bg-white px-4 py-2 text-xs text-slate-500 sm:px-6" role="status">
        {loading ? 'Loading summary…' : `Summary ${UNAVAILABLE}`}
      </div>
    );
  }
  const topTools = stats.topTools?.map(tool => ({ key: tool.name, label: tool.name, count: tool.count })) ?? null;
  const topClients = stats.topClients?.map(client => ({
    key: client.clientId,
    label: clientDisplayName(client),
    count: client.count,
  })) ?? null;
  return (
    <div
      aria-label="MCP access summary"
      role="group"
      className="flex flex-wrap items-start gap-y-3 divide-x divide-slate-200 border-b border-gray-200 bg-white px-4 py-3 sm:px-6"
    >
      <StatTile label="Requests" value={formatMcpCount(stats.total)} />
      <StatTile label="Success" value={formatMcpCount(stats.outcomes?.success)} />
      <StatTile label="Denied" value={formatMcpCount(stats.outcomes?.denied)} tone="text-amber-700" />
      <StatTile label="Errors" value={formatMcpCount(stats.outcomes?.error)} tone="text-red-700" />
      <StatTile label="p50" value={formatMcpDuration(stats.durationMs?.p50)} />
      <StatTile label="p95" value={formatMcpDuration(stats.durationMs?.p95)} />
      <TopList label="Top tools" entries={topTools} />
      <TopList label="Connected apps" entries={topClients} />
    </div>
  );
};

export const McpLogsBlockingState: React.FC<{
  kind: 'loading' | 'error' | 'denied';
  message?: string;
  onRetry?: () => void;
}> = ({ kind, message, onRetry }) => (
  <div className="flex h-full flex-col">
    <div className="flex-shrink-0 border-b border-gray-200 bg-slate-50 px-4 py-2 sm:px-6 sm:py-4">
      <h1 className="text-lg font-bold text-gray-800 sm:text-2xl">MCP Log</h1>
    </div>
    <div className="flex-1 overflow-auto px-4 py-6 sm:px-6">
      {kind === 'loading' && (
        <div role="status" className="flex items-center gap-2 text-gray-500">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Loading MCP access log…
        </div>
      )}
      {kind === 'denied' && (
        <div role="alert" className="max-w-xl border-l-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlert size={16} aria-hidden="true" />Operator access required
          </div>
          <p className="mt-2 text-amber-800">
            {message || 'The MCP access log is only readable by operators who can manage this instance’s settings.'}
          </p>
        </div>
      )}
      {kind === 'error' && (
        <div role="alert" className="max-w-xl border-l-2 border-red-500 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-medium">Couldn’t load the MCP access log.</p>
          <p className="mt-1 text-red-700">{message}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  </div>
);

export const McpLogsEmptyState: React.FC<{ filtered: boolean; onClearFilters: () => void }> = ({ filtered, onClearFilters }) => (
  <div className="mx-4 my-6 rounded-lg border border-dashed border-gray-300 bg-gray-50 py-20 text-center sm:mx-6">
    <Plug className="mx-auto mb-4 h-16 w-16 text-gray-400" aria-hidden="true" />
    <p className="mx-auto max-w-lg px-4 text-gray-500">
      {filtered
        ? 'No MCP requests match these filters in the selected window.'
        : 'No MCP requests recorded in this window — once a connected app calls a tool or reads a resource, every request appears here.'}
    </p>
    {filtered && (
      <button
        type="button"
        onClick={onClearFilters}
        className="mt-4 inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-teal-500"
      >
        Clear filters
      </button>
    )}
  </div>
);

const cell = 'px-2 py-3 align-top text-sm text-gray-700 sm:px-3';

/**
 * One request. Below `sm` the secondary identifiers move onto a second line
 * inside the name cell rather than being truncated away.
 */
export const McpLogRow: React.FC<{ entry: McpAccessLogEntry }> = ({ entry }) => {
  const tone = outcomeTone(entry.outcome);
  const client = clientDisplayName(entry);
  return (
    <tr className={tone.row || 'hover:bg-gray-50'}>
      <td className={`${cell} whitespace-nowrap text-gray-500`}>{formatMcpTimestamp(entry.occurredAt)}</td>
      <td className={`${cell} whitespace-nowrap`}>
        <OutcomeBadge outcome={entry.outcome} status={entry.status} />
      </td>
      <td className={cell}>
        {/* An identifier is never broken mid-token: the column widens, and the
            table scrolls inside its own pane, before the name is cut. */}
        <div className="whitespace-nowrap font-mono text-xs text-slate-800">{entry.name || UNAVAILABLE}</div>
        {/* Secondary identifiers, relocated instead of truncated, on narrow screens. */}
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-slate-500 sm:hidden">
          <span>{entry.kind || UNAVAILABLE}</span>
          <span>· {client}</span>
          {entry.ownerId && <span>· {entry.ownerId}</span>}
          {entry.repository && <span className="break-all">· {entry.repository}</span>}
          {entry.errorCode && <span className="text-red-700">· {entry.errorCode}</span>}
        </div>
      </td>
      <td className={`${cell} hidden whitespace-nowrap sm:table-cell`}>{entry.kind || UNAVAILABLE}</td>
      <td className={`${cell} hidden sm:table-cell`}>
        <span className="whitespace-nowrap">{client}</span>
      </td>
      <td className={`${cell} hidden md:table-cell`}>
        <span className="whitespace-nowrap font-mono text-xs">{entry.ownerId || UNAVAILABLE}</span>
      </td>
      <td className={`${cell} hidden lg:table-cell`}>
        <MonoChip value={entry.repository} />
      </td>
      <td className={`${cell} hidden whitespace-nowrap md:table-cell`}>
        {entry.errorCode
          ? <span className="font-mono text-xs text-red-700">{entry.errorCode}</span>
          : <span className="text-slate-400">{UNAVAILABLE}</span>}
      </td>
      <td className={`${cell} hidden whitespace-nowrap tabular-nums md:table-cell`}>{formatMcpDuration(entry.durationMs)}</td>
      <td className={`${cell} hidden whitespace-nowrap tabular-nums lg:table-cell`}>{formatMcpBytes(entry.resultBytes)}</td>
    </tr>
  );
};

const headerCell = 'px-2 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 sm:px-3';

export const McpLogTable: React.FC<{ entries: McpAccessLogEntry[] }> = ({ entries }) => (
  <table className="min-w-full divide-y divide-gray-200">
    <thead className="bg-gray-50">
      <tr>
        <th scope="col" className={headerCell}>Time</th>
        <th scope="col" className={headerCell}>Outcome</th>
        <th scope="col" className={headerCell}>Tool / resource</th>
        <th scope="col" className={`${headerCell} hidden sm:table-cell`}>Kind</th>
        <th scope="col" className={`${headerCell} hidden sm:table-cell`}>Connected app</th>
        <th scope="col" className={`${headerCell} hidden md:table-cell`}>User</th>
        <th scope="col" className={`${headerCell} hidden lg:table-cell`}>Repository</th>
        <th scope="col" className={`${headerCell} hidden md:table-cell`}>Error code</th>
        <th scope="col" className={`${headerCell} hidden md:table-cell`}>Duration</th>
        <th scope="col" className={`${headerCell} hidden lg:table-cell`}>Size</th>
      </tr>
    </thead>
    <tbody className="divide-y divide-gray-200 bg-white">
      {entries.map(entry => <McpLogRow key={entry.id} entry={entry} />)}
    </tbody>
  </table>
);
