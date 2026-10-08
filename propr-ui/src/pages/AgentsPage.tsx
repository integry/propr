import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, GripVertical, X } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { TERMINAL_AGENT_RUN_STATES, type AgentRunState, type InstanceCatalogAgent } from '@propr/shared';
import { getInstanceCatalog } from '../api/proprApi';
import { listAgentDefinitions, listAgentRuns, type AgentDefinitionRecord } from '../api/agentDefinitionsApi';
import { AgentList } from '../components/Agents/AgentList';
import { AgentEditor } from '../components/Agents/AgentEditor';
import { useDemoMode } from '../contexts/DemoModeContext';
import { TASK_SPLIT_QUERY } from '../hooks/useTaskSelection';

const matchesSplit = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(TASK_SPLIT_QUERY).matches;

/** Whether the viewport is wide enough for the list and an agent side by side (same breakpoint as /tasks). */
function useSplitViewport(): boolean {
  const [split, setSplit] = useState(matchesSplit);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(TASK_SPLIT_QUERY);
    const update = () => setSplit(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return split;
}

/**
 * A detached node the editor renders into, plus a ref that docks it into
 * whichever layout is showing. The narrow page and the split view are
 * different element trees, so an editor rendered inside either would be
 * unmounted on a breakpoint change and lose its unsaved form. Rendered
 * through a portal from a fixed spot in the page instead, the editor keeps its
 * state and only its DOM moves between the layouts.
 */
function useEditorDock() {
  const [host] = useState(() => {
    const node = document.createElement('div');
    node.className = 'flex h-full min-h-0 min-w-0 flex-col';
    return node;
  });
  const dockRef = useCallback((slot: HTMLElement | null) => {
    if (slot && host.parentNode !== slot) slot.appendChild(host);
  }, [host]);
  return { host, dockRef };
}

const DEFINITION_PAGE_SIZE = 200;

/**
 * Every saved agent, read page by page until the reported total is reached,
 * so the list and its search cover the whole collection. The list is ordered
 * by last update, so an edit elsewhere between page reads can shift a row
 * across a page boundary; rows are de-duplicated by id.
 */
async function listAllAgentDefinitions(isActive: () => boolean): Promise<AgentDefinitionRecord[]> {
  const byId = new Map<string, AgentDefinitionRecord>();
  let offset = 0;
  for (;;) {
    const page = await listAgentDefinitions({ limit: DEFINITION_PAGE_SIZE, offset });
    if (!isActive()) return [];
    page.definitions.forEach(definition => { if (!byId.has(definition.id)) byId.set(definition.id, definition); });
    offset += page.definitions.length;
    if (page.definitions.length === 0 || offset >= page.total) return [...byId.values()];
  }
}

/** How often the latest run of an agent whose run is still in progress is read again. */
const RUN_STATE_REFRESH_MS = 5_000;
/**
 * How often every listed agent's latest run is read, whatever its last known
 * state: a schedule or trigger can start a run after one has settled, and a
 * read that failed is retried.
 */
const RUN_STATE_DISCOVERY_MS = 30_000;

const isTerminalRunState = (state: AgentRunState) => (TERMINAL_AGENT_RUN_STATES as readonly AgentRunState[]).includes(state);

/**
 * The latest run state of each listed agent. Runs move on after they start,
 * so while an agent's latest run is unfinished it is read again every
 * RUN_STATE_REFRESH_MS until it settles, and every agent is read again every
 * RUN_STATE_DISCOVERY_MS to find runs started outside this page. A read is applied only if nothing
 * newer was recorded for that agent after it was sent: a run started from the
 * editor in the meantime must not be overwritten by the run before it.
 */
function useLastRunStates(definitions: AgentDefinitionRecord[] | null) {
  const [lastRunStates, setLastRunStates] = useState<Record<string, AgentRunState>>({});
  /** Bumped per agent whenever its state is recorded, so an older read in flight is discarded. */
  const versions = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const record = useCallback((definitionId: string, state: AgentRunState) => {
    versions.current.set(definitionId, (versions.current.get(definitionId) ?? 0) + 1);
    setLastRunStates(current => ({ ...current, [definitionId]: state }));
  }, []);

  // A failed read leaves the row as it was until the next discovery read.
  const refresh = useCallback((definitionId: string) => {
    if (inFlight.current.has(definitionId)) return;
    inFlight.current.add(definitionId);
    const sentAt = versions.current.get(definitionId) ?? 0;
    void listAgentRuns(definitionId, { limit: 1 })
      .then(runs => {
        const latest = runs.runs[0];
        if (activeRef.current && latest && (versions.current.get(definitionId) ?? 0) === sentAt) record(definitionId, latest.state);
      })
      .catch(() => undefined)
      .finally(() => { inFlight.current.delete(definitionId); });
  }, [record]);

  const unfinished = definitions
    ?.filter(definition => lastRunStates[definition.id] && !isTerminalRunState(lastRunStates[definition.id]))
    .map(definition => definition.id)
    .join(',') ?? '';
  useEffect(() => {
    if (!unfinished) return;
    const ids = unfinished.split(',');
    const timer = window.setInterval(() => ids.forEach(refresh), RUN_STATE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh, unfinished]);

  // Read through a ref so the discovery timer is not restarted whenever the list changes.
  const listedIds = useRef<string[]>([]);
  listedIds.current = definitions?.map(definition => definition.id) ?? [];
  useEffect(() => {
    const timer = window.setInterval(() => listedIds.current.forEach(refresh), RUN_STATE_DISCOVERY_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { lastRunStates, recordRun: record, refresh };
}

/** Saves and deletions made in an editor while the list's first read was in flight. */
interface PendingChanges {
  saved: Map<string, AgentDefinitionRecord>;
  deleted: ReadonlySet<string>;
}

/** The later of two saved revisions of one agent; a response answered late must not roll the row back. */
const laterRevision = (current: AgentDefinitionRecord | undefined, incoming: AgentDefinitionRecord): AgentDefinitionRecord =>
  current && current.revision > incoming.revision ? current : incoming;

/**
 * The first read of the list with the saves and deletions made while it was
 * in flight laid over it: the read may have been answered before they
 * happened. A save replaces the row it read unless the row read is a later
 * revision, and a save of an agent the read did not include is listed first.
 */
function reconcileLoadedDefinitions(loaded: AgentDefinitionRecord[], pending: PendingChanges): AgentDefinitionRecord[] {
  const kept = loaded
    .filter(definition => !pending.deleted.has(definition.id))
    .map(definition => {
      const saved = pending.saved.get(definition.id);
      return saved && saved.revision >= definition.revision ? saved : definition;
    });
  const created = [...pending.saved.values()].filter(saved => !loaded.some(definition => definition.id === saved.id)).reverse();
  return [...created, ...kept];
}

/** Saved agents plus the latest run state of each, for the list. */
function useAgentDefinitions() {
  const [definitions, setDefinitions] = useState<AgentDefinitionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { lastRunStates, recordRun, refresh: refreshRunState } = useLastRunStates(definitions);
  /** Saves recorded until the first read is applied; null afterwards, when saves apply to the list directly. */
  const pendingSaves = useRef<Map<string, AgentDefinitionRecord> | null>(new Map());
  /**
   * Every agent deleted from this page, kept for as long as the page is open:
   * a save of that agent answered after the deletion must not list it again.
   */
  const deleted = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    listAllAgentDefinitions(() => active)
      .then(read => {
        if (!active) return;
        const saved = pendingSaves.current ?? new Map<string, AgentDefinitionRecord>();
        const loaded = reconcileLoadedDefinitions(read, { saved, deleted: deleted.current });
        pendingSaves.current = null;
        setDefinitions(loaded);
        // Last run states fill in as they arrive.
        loaded.forEach(definition => refreshRunState(definition.id));
      })
      .catch(loadError => { if (active) setError((loadError as Error).message); });
    return () => { active = false; };
  }, [refreshRunState]);

  const upsert = useCallback((definition: AgentDefinitionRecord) => {
    if (deleted.current.has(definition.id)) return;
    const pending = pendingSaves.current;
    pending?.set(definition.id, laterRevision(pending.get(definition.id), definition));
    setDefinitions(current => {
      const list = current ?? [];
      return list.some(candidate => candidate.id === definition.id)
        ? list.map(candidate => (candidate.id === definition.id ? laterRevision(candidate, definition) : candidate))
        : [definition, ...list];
    });
  }, []);

  const remove = useCallback((definitionId: string) => {
    deleted.current.add(definitionId);
    pendingSaves.current?.delete(definitionId);
    setDefinitions(current => current?.filter(candidate => candidate.id !== definitionId) ?? current);
  }, []);

  return { definitions, lastRunStates, error, upsert, remove, recordRun };
}

/** The instance's enabled agents, so the list can name them; empty until loaded or if the read fails. */
function useCatalogAgents(): InstanceCatalogAgent[] {
  const [agents, setAgents] = useState<InstanceCatalogAgent[]>([]);
  useEffect(() => {
    let active = true;
    getInstanceCatalog()
      .then(catalog => { if (active) setAgents(catalog.agents.filter(agent => agent.enabled)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  return agents;
}

const PANE_ACTION_CLASSES = 'inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

/**
 * `/automations` follows the `/tasks` triage console: on wide screens the list
 * stays on the left and the selected agent opens beside it; on narrow screens
 * the list and an agent are separate pages with a "Back to list" link. The
 * selection is the URL path, so a reload or a shared link restores it.
 */
const AgentsPage: React.FC<{ isNew?: boolean; section?: 'settings' | 'runs' }> = ({ isNew = false, section = 'settings' }) => {
  const { definitionId = null, runId = null } = useParams();
  const navigate = useNavigate();
  const split = useSplitViewport();
  const { isDemoMode } = useDemoMode();
  const { definitions, lastRunStates, error, upsert, remove, recordRun } = useAgentDefinitions();
  const catalogAgents = useCatalogAgents();
  const { host: editorHost, dockRef } = useEditorDock();
  const editing = isNew || definitionId !== null;

  // A save or delete that finishes after its editor was closed only updates the list:
  // navigating would replace whichever editor is open now and discard its edits.
  const onSaved = useCallback((definition: AgentDefinitionRecord, created: boolean, open: boolean) => {
    upsert(definition);
    if (created && open) navigate(`/automations/${encodeURIComponent(definition.id)}`, { replace: true });
  }, [navigate, upsert]);

  const onDeleted = useCallback((id: string, open: boolean) => {
    remove(id);
    if (open) navigate('/automations', { replace: true });
  }, [navigate, remove]);

  const close = useCallback(() => navigate('/automations'), [navigate]);

  useEffect(() => {
    if (!split || !editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable="true"]');
      if (event.key !== 'Escape' || event.defaultPrevented || typing || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, editing, split]);

  const list = (
    <AgentList definitions={definitions} lastRunStates={lastRunStates} error={error} selectedId={definitionId} readOnly={isDemoMode} agents={catalogAgents} />
  );

  const editor = editing && createPortal(
    <AgentEditor
      key={definitionId ?? 'new'}
      definitionId={isNew ? null : definitionId}
      section={runId ? 'run' : section}
      runId={runId}
      headerControls={split ? (
        <button type="button" onClick={close} aria-label="Close automation" title="Close (Esc)" className={PANE_ACTION_CLASSES}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      onSaved={onSaved}
      onDeleted={onDeleted}
      onRunStarted={run => recordRun(run.definitionId, run.state)}
    />,
    editorHost,
  );

  let layout: React.ReactNode;
  if (!split) {
    layout = !editing ? <div className="h-full" data-testid="agents-list-page">{list}</div> : (
      <div className="flex h-full min-h-0 flex-col" data-testid="agents-detail-page">
        <nav className="flex-none border-b border-slate-200 bg-white px-4 py-2">
          <Link to="/automations" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />Back to list
          </Link>
        </nav>
        <div ref={dockRef} className="min-h-0 flex-1" />
      </div>
    );
  } else {
    layout = (
      <PanelGroup id="agent-split-workspace" direction="horizontal" keyboardResizeBy={5} className="h-full bg-white" data-testid="agent-split-workspace">
        <Panel id="agent-split-list" order={1} defaultSize={editing ? 40 : 100} minSize={28}>
          <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="agent-split-list">{list}</div>
        </Panel>
        {editing && (
          <>
            <PanelResizeHandle
              id="agent-split-resize-handle"
              className="group flex w-2 flex-none cursor-col-resize items-center justify-center border-l border-slate-200 bg-slate-50 transition-colors hover:bg-teal-50 focus-visible:bg-teal-50 focus-visible:outline-none"
              aria-label="Resize automation list and automation details"
              hitAreaMargins={{ coarse: 12, fine: 6 }}
            >
              <GripVertical size={12} className="text-slate-400 group-hover:text-teal-700" aria-hidden="true" />
            </PanelResizeHandle>
            <Panel id="agent-split-details" order={2} defaultSize={60} minSize={35}>
              <section ref={dockRef} aria-label="Automation details" className="flex h-full min-h-0 min-w-0 flex-col" data-testid="agent-split-details" />
            </Panel>
          </>
        )}
      </PanelGroup>
    );
  }

  // The editor sits beside the layout rather than inside it, so it stays mounted when the layout changes.
  return <>{editor}{layout}</>;
};

export default AgentsPage;
