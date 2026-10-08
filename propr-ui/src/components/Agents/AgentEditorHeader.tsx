import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Loader2, Play, RotateCw } from 'lucide-react';
import { CONFLICT_MESSAGE } from './useAgentEditor';

export const BUTTON_CLASSES = 'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-50';

interface AgentEditorHeaderProps {
  title: string;
  headerControls?: React.ReactNode;
  canRun: boolean;
  running: boolean;
  runDisabled: boolean;
  /** Why Run now is unavailable, when the reason is something the user can fix. */
  runHint: string | null;
  onRun: () => void;
}

/** Title on the left; Run now and the pane controls pinned to the right edge. Save sits in the form's footer. */
export const AgentEditorHeader: React.FC<AgentEditorHeaderProps> = ({
  title, headerControls, canRun, running, runDisabled, runHint, onRun,
}) => (
  <header className="flex flex-none items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
    <h1 className="min-w-0 truncate text-base font-semibold text-slate-900">{title}</h1>
    <div className="flex flex-none items-center gap-2">
      {canRun && runHint && <span id="agent-run-hint" className="text-xs text-slate-500">{runHint}</span>}
      {canRun && (
        <button
          type="button"
          onClick={onRun}
          disabled={runDisabled}
          aria-describedby={runHint ? 'agent-run-hint' : undefined}
          className={`${BUTTON_CLASSES} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          Run now
        </button>
      )}
      {headerControls}
    </div>
  </header>
);

export type AgentDetailSection = 'settings' | 'runs' | 'run';

const TAB_CLASSES = 'border-b-2 px-1 pb-2 pt-2.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

/** Settings and Runs of a saved agent; a run detail belongs to the Runs tab. */
export const AgentDetailTabs: React.FC<{ definitionId: string; section: AgentDetailSection }> = ({ definitionId, section }) => {
  const base = `/automations/${encodeURIComponent(definitionId)}`;
  const tab = (to: string, label: string, active: boolean) => (
    <NavLink
      to={to}
      end
      aria-current={active ? 'page' : undefined}
      className={`${TAB_CLASSES} ${active ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
    >
      {label}
    </NavLink>
  );
  return (
    <nav aria-label="Automation sections" className="flex flex-none gap-5 border-b border-slate-200 bg-white px-4">
      {tab(base, 'Settings', section === 'settings')}
      {tab(`${base}/runs`, 'Runs', section !== 'settings')}
    </nav>
  );
};

const CRUMB_LINK_CLASSES = 'truncate text-slate-500 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

/** A short, stable name for a run: the start of its id. */
const runShortLabel = (runId: string): string => `Run ${runId.slice(0, 8)}`;

/**
 * Where an open run sits: automation / Runs / this run. It takes the place of
 * the Settings/Runs tabs, so the Runs tab and a "back to Runs" link are never
 * stacked on top of each other.
 */
export const AgentRunBreadcrumb: React.FC<{ definitionId: string; name: string; runId: string }> = ({ definitionId, name, runId }) => {
  const base = `/automations/${encodeURIComponent(definitionId)}`;
  const separator = <ChevronRight className="h-3.5 w-3.5 flex-none text-slate-300" aria-hidden="true" />;
  return (
    <nav aria-label="Breadcrumb" className="flex-none border-b border-slate-200 bg-white px-4 py-2.5" data-testid="agent-run-breadcrumb">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        <li className="min-w-0"><Link to={base} className={CRUMB_LINK_CLASSES}>{name}</Link></li>
        <li className="flex flex-none items-center gap-1.5">{separator}<Link to={`${base}/runs`} className={CRUMB_LINK_CLASSES}>Runs</Link></li>
        <li className="flex min-w-0 items-center gap-1.5">
          {separator}
          <span aria-current="page" className="truncate font-medium text-slate-900" title={runId}>{runShortLabel(runId)}</span>
        </li>
      </ol>
    </nav>
  );
};

/** Shown when a save found the agent changed elsewhere; Reload replaces the form with the saved agent. */
export const AgentConflictBanner: React.FC<{ reloadDisabled: boolean; onReload: () => void }> = ({ reloadDisabled, onReload }) => (
  <div role="alert" className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
    <span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{CONFLICT_MESSAGE}</span>
    <button
      type="button"
      onClick={onReload}
      disabled={reloadDisabled}
      className="inline-flex items-center gap-1 text-sm font-medium text-amber-900 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
    >
      <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />Reload
    </button>
  </div>
);
