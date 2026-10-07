import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentTypeSupportsProprMcp, validateAgentDefinitionInput, type InstanceCatalogAgent } from '@propr/shared';
import { getInstanceCatalog } from '../../api/proprApi';
import {
  createAgentDefinition,
  deleteAgentAttachment,
  deleteAgentDefinition,
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

export const CONFLICT_MESSAGE = 'Changed elsewhere — reload';
export const RUN_NEEDS_SAVE_MESSAGE = 'Save your changes to run them';

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
export function useAgentEditor(definitionId: string | null, { onSaved, onDeleted, onRunStarted }: AgentEditorCallbacks) {
  const [definition, setDefinition] = useState<AgentDefinitionRecord | null>(null);
  const [form, setForm] = useState<AgentEditorForm>(emptyAgentForm);
  const [loading, setLoading] = useState(definitionId !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agents, setAgents] = useState<InstanceCatalogAgent[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set synchronously while a save is in flight, so a run cannot start on the configuration being replaced. */
  const savingRef = useRef(false);
  /** False once this editor unmounts, so a late response no longer acts for it. */
  const openRef = useRef(true);
  useEffect(() => {
    openRef.current = true;
    return () => { openRef.current = false; };
  }, []);

  const load = useCallback(async (id: string, isActive: () => boolean = () => true) => {
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await getAgentDefinition(id);
      if (!isActive()) return;
      setDefinition(loaded);
      setForm(formFromDefinition(loaded));
      setConflict(false);
      setError(null);
    } catch (loadFailure) {
      if (isActive()) setLoadError((loadFailure as Error).message);
    } finally {
      if (isActive()) setLoading(false);
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

  const update = useCallback((patch: AgentEditorFormPatch) => {
    setForm(current => ({ ...current, ...patch }));
    setNotice(null);
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
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = definition
        ? await updateAgentDefinition(definition.id, input, definition.revision)
        : await createAgentDefinition(input);
      if (!openRef.current) { onSaved(saved, !definition, false); return; }
      setDefinition(saved);
      setForm(formFromDefinition(saved));
      setNotice('Saved');
      onSaved(saved, !definition, true);
    } catch (saveFailure) {
      if (!openRef.current) return;
      if (isAgentConflictError(saveFailure)) setConflict(true);
      else setError((saveFailure as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [definition, form, onSaved, proprMcpSupport]);

  const remove = useCallback(async () => {
    if (!definition) return false;
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

  const upload = useCallback(async (files: File[]) => {
    if (!definition) return;
    applyAttachments((await uploadAgentAttachment(definition.id, files)).definition);
  }, [applyAttachments, definition]);

  const removeAttachment = useCallback(async (attachmentId: string) => {
    if (!definition) return;
    applyAttachments(await deleteAgentAttachment(definition.id, attachmentId));
  }, [applyAttachments, definition]);

  const run = useCallback(async () => {
    if (!definition || savingRef.current || dirty) return;
    setRunning(true);
    setError(null);
    try {
      const result = await triggerAgentRun(definition.id);
      setNotice(result.created ? 'Run started' : 'A run is already in progress');
      onRunStarted?.(result.run);
    } catch (runFailure) {
      setError((runFailure as Error).message);
    } finally {
      setRunning(false);
    }
  }, [definition, dirty, onRunStarted]);

  const reload = useCallback(() => (definition ? load(definition.id) : Promise.resolve()), [definition, load]);

  return {
    definition, form, agents, loading, loadError, saving, deleting, running, error, conflict, notice, dirty,
    proprMcpSupport, agentType, update, changeAgent, save, remove, upload, removeAttachment, run, reload,
  };
}
