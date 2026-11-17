import React from 'react';
import { Clock, Info, Zap } from 'lucide-react';
import { LlmLogEntry } from '../api/llmLogsApi';
import { formatModelName } from '../utils/modelDisplay';
import { UsageBadge } from '../components/ui/UsageBadge';
import { RelativeTime } from '../components/ui/RelativeTime';
import {
  formatDuration,
  formatTimestamp,
  formatType,
  getContextDisplay,
  getWorkReferenceDisplay,
  getWorkTypeLabel,
  hasDetailedInfo,
} from './llmLogsUtils';
import { ExpandButton, ExpandedRowDetails, StatusIcon, SyntheticRoutingModelSummary } from './LlmLogsPageComponents';

/**
 * The LLM call list. From `lg` up it is a fixed-layout table: every column has
 * a set width (the work reference takes what is left), so the table always fits
 * its pane, and a long value is cut with an ellipsis and its full text in the
 * tooltip. Below `lg` each call is a stacked row — status, work reference and
 * time on the first line, type, model, usage and duration on the second — the
 * same switch `ListSkeleton layout="table"` makes.
 */

const cellBase = 'min-w-0 text-sm text-gray-700 lg:px-3 lg:py-3 lg:align-top';
/** A cell of every row, stacked or tabular. */
const cell = `${cellBase} lg:table-cell`;
/** A column only the table (`lg` up) shows. */
const desktopCell = `${cellBase} hidden lg:table-cell`;
/** A column only a wide table (`xl` up) shows. */
const wideCell = `${cellBase} hidden xl:table-cell`;

/**
 * Column widths, in table order. `null` columns share the width the others
 * leave. The fixed widths add up to 648px at `lg` and 824px from `xl`, inside a
 * 784px pane at a 1024px viewport and a 1040px pane at 1280px (sidebar 240px).
 */
const LLM_LOG_COLUMNS: Array<{ key: string; label: string; icon?: React.ReactNode; width: string | null; xlOnly?: boolean }> = [
  { key: 'expand', label: '', width: 'w-10' },
  { key: 'status', label: 'Status', width: 'w-20' },
  { key: 'type', label: 'Type', width: 'w-32' },
  { key: 'work', label: 'Work Ref', icon: <Info size={14} aria-hidden="true" />, width: null },
  { key: 'model', label: 'Model', width: 'w-44', xlOnly: true },
  { key: 'usage', label: 'Usage', icon: <Zap size={14} aria-hidden="true" />, width: 'w-44' },
  { key: 'duration', label: 'Duration', icon: <Clock size={14} aria-hidden="true" />, width: 'w-28' },
  { key: 'time', label: 'Timestamp', width: 'w-28' },
];

const WORK_TYPE_TONE: Record<string, string> = {
  task: 'bg-blue-100 text-blue-800',
  plan: 'bg-purple-100 text-purple-800',
};

const TypeBadge: React.FC<{ type: string }> = ({ type }) => (
  <span
    className="inline-block max-w-full truncate rounded-full bg-indigo-100 px-2 py-0.5 align-middle text-xs font-medium text-indigo-800"
    title={formatType(type)}
  >
    {formatType(type)}
  </span>
);

const WorkReference: React.FC<{ log: LlmLogEntry }> = ({ log }) => {
  if (!log.workType) {
    return (
      <span className="block truncate" title={log.repository || log.draftId || log.sessionId || undefined}>
        {getContextDisplay(log)}
      </span>
    );
  }
  const reference = getWorkReferenceDisplay(log);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className={`inline-block flex-none rounded px-1.5 py-0.5 text-xs font-medium ${WORK_TYPE_TONE[log.workType] ?? 'bg-gray-100 text-gray-800'}`}>
        {getWorkTypeLabel(log.workType)}
      </span>
      <span className="min-w-0 truncate" title={reference}>{reference}</span>
    </div>
  );
};

const ModelName: React.FC<{ log: LlmLogEntry }> = ({ log }) => {
  const model = log.modelName ? formatModelName(log.modelName) : '-';
  return <span className="block truncate font-mono" title={log.modelName || undefined}>{model}</span>;
};

const LogTime: React.FC<{ startTime: string | null }> = ({ startTime }) => (
  formatTimestamp(startTime) === '-'
    ? <span>-</span>
    : <RelativeTime value={startTime} className="whitespace-nowrap" />
);

const Usage: React.FC<{ log: LlmLogEntry }> = ({ log }) => (
  <UsageBadge
    tokens={(log.inputTokens || 0) + (log.outputTokens || 0) + (log.cacheCreationInputTokens || 0) + (log.cacheReadInputTokens || 0)}
    cost={log.costUsd ?? undefined}
    usageMetricRecords={log.usageMetricRecords}
    // A call with several usage metrics wraps inside its column rather than widening it.
    className="max-w-full flex-wrap"
  />
);

const LlmLogRow: React.FC<{ log: LlmLogEntry; expanded: boolean; onToggle: (logId: number) => void }> = ({ log, expanded, onToggle }) => {
  const expandable = hasDetailedInfo(log);
  return (
    <tr
      data-testid="llm-log-row"
      className={`flex flex-wrap items-start gap-x-2 px-4 py-2.5 hover:bg-gray-50 sm:px-6 lg:table-row lg:p-0 ${expandable ? 'cursor-pointer' : ''}`}
      onClick={() => expandable && onToggle(log.logId)}
    >
      <td className={`${cell} w-6 flex-none lg:w-auto lg:px-2`}>
        {expandable && (
          <ExpandButton
            isExpanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(log.logId);
            }}
          />
        )}
      </td>
      <td className={`${cell} flex-none pt-0.5`}>
        <div className="flex items-center" title={log.success ? 'Success' : log.errorMessage || 'Failed'}>
          <StatusIcon success={log.success} />
        </div>
      </td>
      <td className={desktopCell}><TypeBadge type={log.executionType} /></td>
      <td className={`${cell} order-1 flex-1 lg:order-none`}>
        <WorkReference log={log} />
        {/* Below lg the other columns are hidden; their values move here instead. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 lg:hidden">
          <TypeBadge type={log.executionType} />
          <span className="min-w-0 max-w-full truncate font-mono" title={log.modelName || undefined}>
            {log.modelName ? formatModelName(log.modelName) : '-'}
          </span>
          <Usage log={log} />
          <span className="tabular-nums">{formatDuration(log.durationMs)}</span>
        </div>
        {/* Between lg and xl the model column is dropped to make room; it reads here. */}
        <div className="mt-1 hidden text-xs text-slate-500 lg:block xl:hidden">
          <ModelName log={log} />
        </div>
        <div className="xl:hidden"><SyntheticRoutingModelSummary value={log.metadata?.syntheticRouting} /></div>
      </td>
      <td className={`${wideCell} font-mono`}>
        <ModelName log={log} />
        <SyntheticRoutingModelSummary value={log.metadata?.syntheticRouting} />
      </td>
      <td className={desktopCell}><Usage log={log} /></td>
      <td className={`${desktopCell} truncate tabular-nums`}>{formatDuration(log.durationMs)}</td>
      <td className={`${cell} order-2 flex-none whitespace-nowrap text-gray-500 lg:order-none`}>
        <LogTime startTime={log.startTime} />
      </td>
    </tr>
  );
};

const headerCell = 'truncate px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500';

export const LlmLogTable: React.FC<{
  logs: LlmLogEntry[];
  expandedRows: Set<number>;
  onToggle: (logId: number) => void;
}> = ({ logs, expandedRows, onToggle }) => (
  <table data-testid="llm-log-table" className="block w-full lg:table lg:table-fixed">
    <thead className="hidden bg-gray-50 lg:table-header-group">
      <tr className="border-b border-gray-200">
        {LLM_LOG_COLUMNS.map(column => (
          <th
            key={column.key}
            scope="col"
            title={column.label || undefined}
            className={`${headerCell} ${column.width ?? ''} ${column.xlOnly ? 'hidden xl:table-cell' : ''}`}
          >
            {column.label && (
              <span className="flex min-w-0 items-center gap-1">
                {column.icon}
                <span className="truncate">{column.label}</span>
              </span>
            )}
          </th>
        ))}
      </tr>
    </thead>
    <tbody className="block divide-y divide-gray-200 bg-white lg:table-row-group">
      {logs.map(log => (
        <React.Fragment key={log.logId}>
          <LlmLogRow log={log} expanded={expandedRows.has(log.logId)} onToggle={onToggle} />
          {expandedRows.has(log.logId) && <ExpandedRowDetails log={log} />}
        </React.Fragment>
      ))}
    </tbody>
  </table>
);
