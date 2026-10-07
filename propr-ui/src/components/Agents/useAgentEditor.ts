import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { agentTypeSupportsProprMcp, validateAgentDefinitionInput, type InstanceCatalogAgent } from '@propr/shared';
import { getInstanceCatalog } from '../../api/proprApi';
import {
  createAgentDefinition,
  deleteAgentAttachment,
  deleteAgentDefinition,
  getAgentCapacity,
  getAgentDefinition,
  isAgentConflictError,
  triggerAgentRun,
  updateAgentDefinition,
  uploadAgentAttachment,
  type AgentDefinitionRecord,
  type AgentRunRecord,
} from '../../api/agentDefinitionsApi';
import { emptyAgentForm, formFromDefinition, formToInput, type AgentEditorForm, type AgentEditorFormPatch } from './agentEditorForm';
import type { ProprMcpSupport } from './AgentCapabilitiesSection';
import { capacityWarning } from './agentRunPresentation';

export interface AgentEditorCallbacks {
  /**
   * `open` is false when the editor that started the save was closed before
   * the response came back: the list should still learn of the result, but
   * nothing may navigate on its behalf, since another editor may be showing.
   */
  onSaved: (definition: AgentDefinitionRecord, created: boolean, open: boolean) => void;
  onDeleted: (definitionId: string, open: boolean) => void;
  onRunStarted?: (run: AgentRunRecord) => void;
}

/** A short confirmation of what a save or Run now did, shown as a toast rather than in the header. */
export type AgentEditorNotify = (message: string, type: 'success' | 'info') => void;

interface AgentEditorOptions {
  /** Opens a run Run now started (or the one already in progress), while this editor is still open. */
  openRun?: (run: AgentRunRecord) => void;
  notify?: AgentEditorNotify;
}

export const CONFLICT_MESSAGE = 'Changed elsewhere — reload';
export const RUN_NEEDS_SAVE_MESSAGE = 'Save your changes to run them';

interface RunGate { running: boolean; saving: boolean; dirty: boolean; conflict: boolean; loading: boolean; attachmentsPending: boolean; disabledAgent: boolean }

/**
 * Run now starts the definition the server holds, so it is held back while a
 * save is replacing it, while the form shows changes that are not saved yet,
 * while the agent changed elsewhere and its replacement has not loaded, and
 * while input files are still being added or removed. A disabled agent
 * cannot be run at all.
 */
export function runAvailability(isDemoMode: boolean, { running, saving, dirty, conflict, loading, attachmentsPending, disabledAgent }: RunGate) {
  let runHint: string | null = null;
  if (!isDemoMode && disabledAgent) runHint = 'This automation is disabled';
  else if (!isDemoMode && dirty && !saving && !conflict) runHint = RUN_NEEDS_SAVE_MESSAGE;
  return {
    runDisabled: isDemoMode || disabledAgent || running || saving || dirty || conflict || loading || attachmentsPending,
    runHint,
  };
}

/** Whether the form would save something other than the definition as loaded. */
export function formDiffersFrom(form: AgentEditorForm, definition: AgentDefinitionRecord): boolean {
  return JSON.stringify(formToInput(form)) !== JSON.stringify(formToInput(formFromDefinition(definition)));
}

/** Whether the chosen agent can be given ProPR's MCP tools, judged from the instance catalog. */
export function proprMcpSupportFor(agents: readonly InstanceCatalogAgent[], alias: string | null): { support: ProprMcpSupport; agentType: string | null } {
  if (!alias) return { support: 'unknown', agentType: null };
  const agent = agents.find(candidate => candidate.alias === alias);
  if (!agent?.type) return { support: 'unknown', agentType: null };
  return { support: agentTypeSupportsProprMcp(agent.type) ? 'supported' : 'unsupported', agentType: agent.type };
}

/**
 * State and actions behind the agent editor: the loaded definition and its
 * revision, the working form, and save/delete/upload/run. Saving an existing
 * agent sends the revision it was loaded at, so an edit made elsewhere in the
 * meantime surfaces as a conflict instead of being overwritten.
 */
export function useAgentEditor(
  definitionId: string | null,
  { onSaved, onDeleted, onRunStarted }: AgentEditorCallbacks,
  { openRun, notify }: AgentEditorOptions = {},
) {
  const [definition, setDefinition] = useState<AgentDefinitionRecord | null>(null);
  const [form, setForm] = useState<AgentEditorForm>(emptyAgentForm);
  const [loading, setLoading] = useState(definitionId !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agents, setAgents] = useState<InstanceCatalogAgent[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);
  /** The near-limit question Run now is waiting on, if the agent's subscription is close to its pause threshold. */
  const [capacityQuestion, setCapacityQuestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [attachmentsPending, setAttachmentsPending] = useState(0);
  /** Set synchronously while a save is in flight, so a run cannot start on the configuration being replaced. */
  const savingRef = useRef(false);
  /**
   * Set synchronously when a save finds the agent changed elsewhere, and
   * cleared only once the replacement has loaded: until then the form shows a
   * configuration the server no longer holds, so a run would start another.
   */
  const conflictRef = useRef(false);
  /** Set synchronously while the definition is (re)loading, for the same reason. */
  const loadingRef = useRef(definitionId !== null);
  /** Input file uploads and removals still awaiting a response; a run waits for them to settle. */
  const attachmentsPendingRef = useRef(0);
  /** False once this editor unmounts, so a late response no longer acts for it. */
  const openRef = useRef(true);
  useEffect(() => {
    openRef.current = true;
    return () => { openRef.current = false; };
  }, []);

  const load = useCallback(async (id: string, isActive: () => boolean = () => true) => {
    loadingRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await getAgentDefinition(id);
      if (!isActive()) return;
      setDefinition(loaded);
      setForm(formFromDefinition(loaded));
      conflictRef.current = false;
      setConflict(false);
      setError(null);
    } catch (loadFailure) {
      if (isActive()) setLoadError((loadFailure as Error).message);
    } finally {
      if (isActive()) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!definitionId) return;
    let active = true;
    void load(definitionId, () => active);
    return () => { active = false; };
  }, [definitionId, load]);

  useEffect(() => {
    let active = true;
    getInstanceCatalog()
      .then(catalog => { if (active) setAgents(catalog.agents.filter(agent => agent.enabled)); })
      .catch(() => { /* The selector shows "No agents configured"; the server still validates. */ });
    return () => { active = false; };
  }, []);

  const { support: proprMcpSupport, agentType } = useMemo(() => proprMcpSupportFor(agents, form.agentId), [agents, form.agentId]);
  /** A run uses the saved definition, so it is offered only while the form shows exactly that. */
  const dirty = useMemo(() => Boolean(definition && formDiffersFrom(form, definition)), [definition, form]);
  /**
   * The definition and dirtiness as last rendered, for a run resuming after
   * the capacity check: the form stays editable meanwhile, and the callback
   * it resumes in still holds the values from when Run now was clicked.
   */
  const definitionRef = useRef(definition);
  const dirtyRef = useRef(dirty);
  useLayoutEffect(() => {
    definitionRef.current = definition;
    dirtyRef.current = dirty;
  }, [definition, dirty]);

  const update = useCallback((patch: AgentEditorFormPatch) => {
    setForm(current => ({ ...current, ...patch }));
  }, []);

  /** Picking an agent that cannot use ProPR tools drops the options that need them. */
  const changeAgent = useCallback((agentId: string | null) => {
    setForm(current => {
      const next = { ...current, agentId };
      if (proprMcpSupportFor(agents, agentId).support !== 'unsupported') return next;
      return { ...next, capabilities: next.capabilities.filter(capability => capability !== 'propr_mcp'), autonomy: 'dry_run' };
    });
  }, [agents]);

  const save = useCallback(async () => {
    const input = formToInput(form);
    if (proprMcpSupport === 'unsupported') input.capabilities = input.capabilities?.filter(capability => capability !== 'propr_mcp');
    const invalid = validateAgentDefinitionInput(input);
    if (invalid) { setError(invalid); return; }
    // Both return a whole definition; a save answered after an attachment change would restore the old file list.
    if (attachmentsPendingRef.current > 0) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = definition
        ? await updateAgentDefinition(definition.id, input, definition.revision)
        : await createAgentDefinition(input);
      if (!openRef.current) { onSaved(saved, !definition, false); return; }
      setDefinition(saved);
      setForm(formFromDefinition(saved));
      notify?.(definition ? 'Automation saved' : 'Automation created', 'success');
      onSaved(saved, !definition, true);
    } catch (saveFailure) {
      if (!openRef.current) return;
      if (isAgentConflictError(saveFailure)) {
        conflictRef.current = true;
        setConflict(true);
      }
      else setError((saveFailure as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [definition, form, notify, onSaved, proprMcpSupport]);

  const remove = useCallback(async () => {
    // A save answered after the deletion would describe an agent that no longer exists.
    if (!definition || savingRef.current) return false;
    setDeleting(true);
    setError(null);
    try {
      await deleteAgentDefinition(definition.id);
      onDeleted(definition.id, openRef.current);
      return true;
    } catch (deleteFailure) {
      setError((deleteFailure as Error).message);
      return false;
    } finally {
      setDeleting(false);
    }
  }, [definition, onDeleted]);

  /** Input files do not change the revision, so only the attachment list is taken from the response. */
  const applyAttachments = useCallback((changed: AgentDefinitionRecord) => {
    setDefinition(current => (current ? { ...current, attachments: changed.attachments } : current));
  }, []);

  /** Counts an attachment change as outstanding until its response arrives, whatever the outcome. */
  const trackAttachments = useCallback(async (change: () => Promise<AgentDefinitionRecord>) => {
    attachmentsPendingRef.current += 1;
    setAttachmentsPending(count => count + 1);
    try {
      applyAttachments(await change());
    } finally {
      attachmentsPendingRef.current -= 1;
      setAttachmentsPending(count => count - 1);
    }
  }, [applyAttachments]);

  // A reload answered after the change would bring back the file list from before it.
  const upload = useCallback(async (files: File[]) => {
    if (!definition || savingRef.current || loadingRef.current) return;
    await trackAttachments(async () => (await uploadAgentAttachment(definition.id, files)).definition);
  }, [definition, trackAttachments]);

  const removeAttachment = useCallback(async (attachmentId: string) => {
    if (!definition || savingRef.current || loadingRef.current) return;
    await trackAttachments(() => deleteAgentAttachment(definition.id, attachmentId));
  }, [definition, trackAttachments]);

  const runBlocked = useCallback(
    () => !definitionRef.current || dirtyRef.current || savingRef.current || conflictRef.current || loadingRef.current || attachmentsPendingRef.current > 0,
    [],
  );

  /** Judged on current state, as it may run after an await during which the form, a save or a file change moved on. */
  const startRun = useCallback(async () => {
    const current = definitionRef.current;
    if (!current || runBlocked()) return;
    setRunning(true);
    setError(null);
    try {
      const result = await triggerAgentRun(current.id);
      if (result.created) notify?.('Run started', 'success');
      else notify?.('A run is already in progress', 'info');
      onRunStarted?.(result.run);
      if (openRef.current) openRun?.(result.run);
    } catch (runFailure) {
      setError((runFailure as Error).message);
    } finally {
      setRunning(false);
    }
  }, [notify, onRunStarted, openRun, runBlocked]);

  /**
   * Run now checks the agent's subscription first. Attended runs may go ahead
   * near the limit, but only once the user has confirmed it; when the usage
   * cannot be read the run starts and the server's own gate decides. However
   * the check ends, including a start refused because something changed while
   * it was pending, Run now is offered again afterwards.
   */
  const run = useCallback(async () => {
    if (!definition || runBlocked()) return;
    setRunning(true);
    setError(null);
    try {
      let warning: string | null = null;
      try {
        warning = capacityWarning(await getAgentCapacity(definition.id));
      } catch {
        warning = null;
      }
      if (!openRef.current) return;
      if (warning) {
        setCapacityQuestion(warning);
        return;
      }
      await startRun();
    } finally {
      setRunning(false);
    }
  }, [definition, runBlocked, startRun]);

  const confirmRun = useCallback(async () => {
    setCapacityQuestion(null);
    await startRun();
  }, [startRun]);

  const dismissRun = useCallback(() => setCapacityQuestion(null), []);

  /** Waits out attachment changes: a read taken before one commits would replace the file list it produced. */
  const reload = useCallback(() => {
    if (!definition || loadingRef.current || attachmentsPendingRef.current > 0) return Promise.resolve();
    return load(definition.id);
  }, [definition, load]);

  return {
    definition, form, agents, loading, loadError, saving, deleting, running, error, conflict, dirty,
    attachmentsPending: attachmentsPending > 0,
    proprMcpSupport, agentType, update, changeAgent, save, remove, upload, removeAttachment, run, reload,
    capacityQuestion, confirmRun, dismissRun,
  };
}
