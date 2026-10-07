import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, GripVertical, X } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { AgentRunState } from '@propr/shared';
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

/** Saved agents plus the latest run state of each, for the list. */
function useAgentDefinitions() {
  const [definitions, setDefinitions] = useState<AgentDefinitionRecord[] | null>(null);
  const [lastRunStates, setLastRunStates] = useState<Record<string, AgentRunState>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listAllAgentDefinitions(() => active)
      .then(loaded => {
        if (!active) return;
        setDefinitions(loaded);
        // Last run states fill in as they arrive; a failed read just leaves the row at "Never run".
        loaded.forEach(definition => {
          void listAgentRuns(definition.id, { limit: 1 })
            .then(runs => {
              const latest = runs.runs[0];
              if (active && latest) setLastRunStates(current => ({ ...current, [definition.id]: latest.state }));
            })
            .catch(() => undefined);
        });
      })
      .catch(loadError => { if (active) setError((loadError as Error).message); });
    return () => { active = false; };
  }, []);

  const upsert = useCallback((definition: AgentDefinitionRecord) => {
    setDefinitions(current => {
      const list = current ?? [];
      return list.some(candidate => candidate.id === definition.id)
        ? list.map(candidate => (candidate.id === definition.id ? definition : candidate))
        : [definition, ...list];
    });
  }, []);

  const remove = useCallback((definitionId: string) => {
    setDefinitions(current => current?.filter(candidate => candidate.id !== definitionId) ?? current);
  }, []);

  const recordRun = useCallback((definitionId: string, state: AgentRunState) => {
    setLastRunStates(current => ({ ...current, [definitionId]: state }));
  }, []);

  return { definitions, lastRunStates, error, upsert, remove, recordRun };
}

const PANE_ACTION_CLASSES = 'inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

/**
 * `/agents` follows the `/tasks` triage console: on wide screens the list
 * stays on the left and the selected agent opens beside it; on narrow screens
 * the list and an agent are separate pages with a "Back to list" link. The
 * selection is the URL path, so a reload or a shared link restores it.
 */
const AgentsPage: React.FC<{ isNew?: boolean }> = ({ isNew = false }) => {
  const { definitionId = null } = useParams();
  const navigate = useNavigate();
  const split = useSplitViewport();
  const { isDemoMode } = useDemoMode();
  const { definitions, lastRunStates, error, upsert, remove, recordRun } = useAgentDefinitions();
  const { host: editorHost, dockRef } = useEditorDock();
  const editing = isNew || definitionId !== null;

  const onSaved = useCallback((definition: AgentDefinitionRecord, created: boolean) => {
    upsert(definition);
    if (created) navigate(`/agents/${encodeURIComponent(definition.id)}`, { replace: true });
  }, [navigate, upsert]);

  const onDeleted = useCallback((id: string) => {
    remove(id);
    navigate('/agents', { replace: true });
  }, [navigate, remove]);

  const close = useCallback(() => navigate('/agents'), [navigate]);

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
    <AgentList definitions={definitions} lastRunStates={lastRunStates} error={error} selectedId={definitionId} readOnly={isDemoMode} />
  );

  const editor = editing && createPortal(
    <AgentEditor
      key={definitionId ?? 'new'}
      definitionId={isNew ? null : definitionId}
      headerControls={split ? (
        <button type="button" onClick={close} aria-label="Close agent" title="Close (Esc)" className={PANE_ACTION_CLASSES}>
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
          <Link to="/agents" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
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
              aria-label="Resize agent list and agent details"
              hitAreaMargins={{ coarse: 12, fine: 6 }}
            >
              <GripVertical size={12} className="text-slate-400 group-hover:text-teal-700" aria-hidden="true" />
            </PanelResizeHandle>
            <Panel id="agent-split-details" order={2} defaultSize={60} minSize={35}>
              <section ref={dockRef} aria-label="Agent details" className="flex h-full min-h-0 min-w-0 flex-col" data-testid="agent-split-details" />
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
