import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, Loader2 } from 'lucide-react';
import { getAgentRun, listAgentRuns, type AgentRunRecord } from '../../api/agentDefinitionsApi';
import { ListSkeleton } from '../ui/Skeleton';
import { SystemAlert } from '../ui/SystemAlert';
import { AgentRunStateBadge } from './AgentRunStateBadge';
import {
  RUN_TRIGGER_LABELS,
  formatRelativeTime,
  formatTimestamp,
  recalledReportPreview,
  rememberReportPreview,
  runDuration,
  runStartedAt,
} from './agentRunPresentation';

export const AGENT_RUN_PAGE_SIZE = 20;

interface AgentRunHistoryProps {
  definitionId: string;
  /** Reference time for relative times and running durations. */
  now?: number;
}

const ROW_GRID = 'grid grid-cols-[minmax(5.5rem,auto)_minmax(5rem,auto)_minmax(7rem,auto)_3.5rem_minmax(0,1fr)] items-center gap-3';

const runPath = (definitionId: string, runId: string) =>
  `/automations/${encodeURIComponent(definitionId)}/runs/${encodeURIComponent(runId)}`;

/** Whether a run has a report worth reading for its preview. */
const hasReport = (run: AgentRunRecord) => run.reportedAt !== null;

/**
 * A run's one-line report preview. The list carries no reports, so the run is
 * read the first time its row is hovered or focused; previews already known
 * (from an earlier hover or from the run detail) show straight away.
 */
function useReportPreviews() {
  const [, setVersion] = useState(0);
  const inFlight = useRef(new Set<string>());
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const load = useCallback((run: AgentRunRecord) => {
    if (!hasReport(run) || recalledReportPreview(run.id) !== undefined || inFlight.current.has(run.id)) return;
    inFlight.current.add(run.id);
    void getAgentRun(run.id)
      .then(detail => {
        rememberReportPreview(run.id, detail.report);
        if (activeRef.current) setVersion(version => version + 1);
      })
      .catch(() => undefined)
      .finally(() => { inFlight.current.delete(run.id); });
  }, []);

  return load;
}

const AgentRunRow: React.FC<{ definitionId: string; run: AgentRunRecord; now: number; onPreview: (run: AgentRunRecord) => void }> = ({
  definitionId, run, now, onPreview,
}) => {
  const preview = recalledReportPreview(run.id);
  const started = runStartedAt(run);
  return (
    <li>
      <Link
        to={runPath(definitionId, run.id)}
        data-testid="agent-run-row"
        onMouseEnter={() => onPreview(run)}
        onFocus={() => onPreview(run)}
        className={`${ROW_GRID} border-b border-slate-100 px-4 py-2 text-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500`}
      >
        <time dateTime={new Date(started).toISOString()} title={formatTimestamp(started)} className="whitespace-nowrap text-slate-700">
          {formatRelativeTime(started, now)}
        </time>
        <span title={run.triggerSource ?? undefined} className="truncate text-slate-600">{RUN_TRIGGER_LABELS[run.trigger]}</span>
        <span><AgentRunStateBadge state={run.state} /></span>
        <span className="whitespace-nowrap text-xs tabular-nums text-slate-500">{runDuration(run, now)}</span>
        <span className="truncate text-xs text-slate-500" data-testid="agent-run-preview">
          {preview ?? (hasReport(run) ? <span className="text-slate-400">Hover to preview the report</span> : null)}
        </span>
      </Link>
    </li>
  );
};

/** The agent's runs, newest first, a page at a time; a row opens the run. */
export const AgentRunHistory: React.FC<AgentRunHistoryProps> = ({ definitionId, now = Date.now() }) => {
  const [runs, setRuns] = useState<AgentRunRecord[] | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadPreview = useReportPreviews();
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setRuns(null);
    setError(null);
    listAgentRuns(definitionId, { limit: AGENT_RUN_PAGE_SIZE, offset: 0 })
      .then(page => {
        if (!active) return;
        setRuns(page.runs);
        setNextOffset(page.nextOffset);
      })
      .catch(loadError => { if (active) setError((loadError as Error).message); });
    return () => { active = false; };
  }, [definitionId, attempt]);

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listAgentRuns(definitionId, { limit: AGENT_RUN_PAGE_SIZE, offset: nextOffset });
      if (!activeRef.current) return;
      // A run started since the first page shifts older runs down a page; keep each once.
      setRuns(current => {
        const list = current ?? [];
        const known = new Set(list.map(run => run.id));
        return [...list, ...page.runs.filter(run => !known.has(run.id))];
      });
      setNextOffset(page.nextOffset);
    } catch (loadError) {
      if (activeRef.current) setError((loadError as Error).message);
    } finally {
      if (activeRef.current) setLoadingMore(false);
    }
  }, [definitionId, loadingMore, nextOffset]);

  if (runs === null) {
    return error
      ? <div className="p-4"><SystemAlert onRetry={() => setAttempt(count => count + 1)}>{error}</SystemAlert></div>
      : <ListSkeleton layout="row" rows={5} label="Loading runs…" className="p-4" />;
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-16 text-center" data-testid="agent-runs-empty">
        <History className="h-10 w-10 text-slate-300" strokeWidth={1.5} aria-hidden="true" />
        <h2 className="mt-4 text-base font-semibold text-slate-900">No runs yet</h2>
        <p className="mt-2 max-w-md text-sm text-slate-500">Use Run now, or give the automation a schedule, and its runs and reports will appear here.</p>
      </div>
    );
  }

  return (
    <div data-testid="agent-run-history">
      <div className={`${ROW_GRID} border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500`} aria-hidden="true">
        <span>Started</span><span>Trigger</span><span>State</span><span>Duration</span><span>Report</span>
      </div>
      <ul aria-label="Runs">
        {runs.map(run => <AgentRunRow key={run.id} definitionId={definitionId} run={run} now={now} onPreview={loadPreview} />)}
      </ul>
      {error && <div className="px-4 pt-3"><SystemAlert>{error}</SystemAlert></div>}
      {nextOffset !== null && (
        <div className="flex justify-center px-4 py-3">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:opacity-60"
          >
            {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Load more
          </button>
        </div>
      )}
    </div>
  );
};

export default AgentRunHistory;
