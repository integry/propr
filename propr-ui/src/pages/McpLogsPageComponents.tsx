import React from 'react';
import { PageHeading } from '../components/ui/PageHeading';
import { ShieldAlert, Plug, TriangleAlert } from 'lucide-react';
import { ListSkeleton } from '../components/ui/Skeleton';
import { RelativeTime } from '../components/ui/RelativeTime';
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
          <span className="ml-1 text-slate-500">{formatMcpCount(entry.count)}</span>
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
  onClearFilters?: () => void;
}> = ({ kind, message, onRetry, onClearFilters }) => (
  <div className="flex h-full flex-col bg-white">
    <div className="flex-shrink-0 border-b border-gray-200 bg-slate-50 px-4 py-2 sm:px-6 sm:py-4">
      <PageHeading>MCP Log</PageHeading>
    </div>
    <div className="flex-1 overflow-auto px-4 py-6 sm:px-6">
      {kind === 'loading' && (
        <ListSkeleton rows={10} layout="table" columns={10} label="Loading MCP access log…" data-testid="mcp-logs-skeleton" />
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
          {onClearFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              className="ml-2 mt-3 inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium text-teal-700 transition-colors hover:text-teal-900 focus:outline-none focus:ring-2 focus:ring-teal-500"
            >
              Clear filters
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

/**
 * Layout of the request list. From `lg` up it is a fixed-layout table: every
 * column has a set width (the tool, app and repository columns share what is
 * left), so the table always fits its pane and a long value is cut with an
 * ellipsis and its full text in the tooltip. Below `lg` each request is a
 * stacked row — outcome, name and time on the first line, the rest of its
 * identifiers on the second — the same switch `ListSkeleton layout="table"` makes.
 */
const cellBase = 'min-w-0 text-sm text-gray-700 lg:px-3 lg:py-3 lg:align-top';
/** A cell of every row, stacked or tabular. */
const cell = `${cellBase} lg:table-cell`;
/** A column only the table (`lg` up) shows. */
const desktopCell = `${cellBase} hidden truncate lg:table-cell`;
/** A column only a wide table (`xl` up) shows. */
const wideCell = `${cellBase} hidden truncate xl:table-cell`;

/** A value that is cut to its column with an ellipsis, its full text in the tooltip. */
const Truncated: React.FC<{ value: string | null | undefined; className?: string }> = ({ value, className = '' }) => (
  value
    ? <span className={`block truncate ${className}`} title={value}>{value}</span>
    : <span className="text-slate-400">{UNAVAILABLE}</span>
);

const McpLogTime: React.FC<{ occurredAt: number | null | undefined }> = ({ occurredAt }) => (
  formatMcpTimestamp(occurredAt) === UNAVAILABLE
    ? <span className="text-slate-400">{UNAVAILABLE}</span>
    : <RelativeTime value={occurredAt} className="whitespace-nowrap" />
);

export const McpLogRow: React.FC<{ entry: McpAccessLogEntry }> = ({ entry }) => {
  const tone = outcomeTone(entry.outcome);
  const client = clientDisplayName(entry);
  return (
    <tr
      data-testid="mcp-log-row"
      className={`flex flex-wrap items-start gap-x-3 px-4 py-2.5 sm:px-6 lg:table-row lg:p-0 ${tone.row || 'hover:bg-gray-50'}`}
    >
      <td className={`${cell} order-2 flex-none whitespace-nowrap text-gray-500 lg:order-none`}>
        <McpLogTime occurredAt={entry.occurredAt} />
      </td>
      <td className={`${cell} order-none flex-none whitespace-nowrap`}>
        <OutcomeBadge outcome={entry.outcome} status={entry.status} />
      </td>
      <td className={`${cell} order-1 flex-1 lg:order-none`}>
        <Truncated value={entry.name} className="font-mono text-xs text-slate-800" />
        {/* Below lg the other columns are hidden; their values move here instead. */}
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-slate-500 lg:hidden">
          <span>{entry.kind || UNAVAILABLE}</span>
          <span>· {client}</span>
          {entry.ownerId && <span className="break-all">· {entry.ownerId}</span>}
          {entry.repository && <span className="break-all font-mono">· {entry.repository}</span>}
          {entry.errorCode && <span className="font-mono text-red-700">· {entry.errorCode}</span>}
          <span className="tabular-nums">· {formatMcpDuration(entry.durationMs)}</span>
          <span className="tabular-nums">· {formatMcpBytes(entry.resultBytes)}</span>
        </div>
        {/* Between lg and xl the kind, user and size columns are dropped to make room; they read here. */}
        <div className="mt-1 hidden gap-x-2 text-[11px] text-slate-500 lg:flex xl:hidden">
          <span className="flex-none">{entry.kind || UNAVAILABLE}</span>
          {entry.ownerId && <span className="truncate font-mono" title={entry.ownerId}>{entry.ownerId}</span>}
          <span className="flex-none tabular-nums">{formatMcpBytes(entry.resultBytes)}</span>
        </div>
      </td>
      <td className={wideCell}>{entry.kind || UNAVAILABLE}</td>
      <td className={desktopCell}><Truncated value={client === UNAVAILABLE ? null : client} /></td>
      <td className={wideCell}>
        <Truncated value={entry.ownerId} className="font-mono text-xs" />
      </td>
      <td className={desktopCell}>
        <Truncated value={entry.repository} className="font-mono text-xs text-slate-700" />
      </td>
      <td className={desktopCell}>
        <Truncated value={entry.errorCode} className="font-mono text-xs text-red-700" />
      </td>
      <td className={`${desktopCell} tabular-nums`}>{formatMcpDuration(entry.durationMs)}</td>
      <td className={`${wideCell} tabular-nums`}>{formatMcpBytes(entry.resultBytes)}</td>
    </tr>
  );
};

const headerCell = 'truncate px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500';

/**
 * Column widths, in table order. `null` columns share the width the others
 * leave. The fixed widths add up to 400px at `lg` and 656px from `xl`, inside a
 * 784px pane at a 1024px viewport and a 1040px pane at 1280px (sidebar 240px).
 */
const MCP_COLUMNS: Array<{ label: string; width: string | null; xlOnly?: boolean }> = [
  { label: 'Time', width: 'w-28' },
  { label: 'Outcome', width: 'w-24' },
  { label: 'Tool / resource', width: null },
  { label: 'Kind', width: 'w-20', xlOnly: true },
  { label: 'Connected app', width: null },
  { label: 'User', width: 'w-24', xlOnly: true },
  { label: 'Repository', width: null },
  { label: 'Error code', width: 'w-24' },
  { label: 'Duration', width: 'w-24' },
  { label: 'Size', width: 'w-20', xlOnly: true },
];

export const McpLogTable: React.FC<{ entries: McpAccessLogEntry[] }> = ({ entries }) => (
  <table data-testid="mcp-log-table" className="block w-full lg:table lg:table-fixed">
    <thead className="hidden bg-gray-50 lg:table-header-group">
      <tr className="border-b border-gray-200">
        {MCP_COLUMNS.map(column => (
          <th
            key={column.label}
            scope="col"
            title={column.label}
            className={`${headerCell} ${column.width ?? ''} ${column.xlOnly ? 'hidden xl:table-cell' : ''}`}
          >
            {column.label}
          </th>
        ))}
      </tr>
    </thead>
    <tbody className="block divide-y divide-gray-200 bg-white lg:table-row-group">
      {entries.map(entry => <McpLogRow key={entry.id} entry={entry} />)}
    </tbody>
  </table>
);
