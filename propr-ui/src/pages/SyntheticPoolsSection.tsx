import React, { useEffect, useMemo, useState } from 'react';
import { Layers3, Plus, Trash2, X } from 'lucide-react';
import type {
  SyntheticAgentConfig,
  SyntheticModelConfig,
  SyntheticModelMember,
} from '@propr/shared';
import type { AgentConfig } from '../api/proprApi';
import Alert from './SettingsPage/Alert';

interface SyntheticPoolsSectionProps {
  agents: AgentConfig[];
  pools: SyntheticAgentConfig[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  warning: string | null;
  success: string | null;
  readOnly?: boolean;
  readOnlyMessage?: string;
  editorActive?: boolean;
  addRequested?: number;
  onAddRequestConsumed?: (request: number) => void;
  onSave: (pools: SyntheticAgentConfig[]) => Promise<SyntheticAgentConfig[] | undefined>;
}

const uuid = () => crypto.randomUUID();

function updateUsageLimit(
  member: SyntheticModelMember,
  key: 'sessionMaxPercent' | 'weeklyMaxPercent',
  value: string,
): SyntheticModelMember {
  const usageLimits = { ...member.usageLimits, [key]: value ? Number(value) : undefined };
  const hasLimit = usageLimits.sessionMaxPercent !== undefined || usageLimits.weeklyMaxPercent !== undefined;
  return { ...member, usageLimits: hasLimit ? usageLimits : undefined };
}

function newMember(agents: AgentConfig[]): SyntheticModelMember {
  const agent = agents.find(candidate => candidate.enabled && candidate.supportedModels.length > 0)
    ?? agents.find(candidate => candidate.supportedModels.length > 0);
  return {
    id: uuid(),
    directAgentAlias: agent?.alias ?? '',
    model: agent?.supportedModels[0] ?? '',
    enabled: true,
    priority: 100,
  };
}

function newModel(agents: AgentConfig[], id = 'default'): SyntheticModelConfig {
  return {
    id,
    displayName: id === 'default' ? 'Default' : undefined,
    enabled: true,
    strategy: 'round_robin',
    members: [newMember(agents)],
  };
}

function newPool(agents: AgentConfig[]): SyntheticAgentConfig {
  return {
    id: uuid(),
    alias: '',
    enabled: true,
    defaultModel: 'default',
    models: [newModel(agents)],
  };
}

function parseFieldErrors(message: string | null): Map<string, string> {
  const errors = new Map<string, string>();
  if (!message) return errors;
  for (const part of message.split(';')) {
    const match = part.trim().match(/^synthetic_agents\.(\d+)(?:\.([^:]+))?:\s*(.+)$/);
    if (match) errors.set(`${match[1]}${match[2] ? `.${match[2]}` : ''}`, match[3]);
  }
  return errors;
}

const inputClass = 'w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:bg-slate-100';

const FieldError: React.FC<{ message?: string }> = ({ message }) => message
  ? <p className="mt-1 text-xs text-red-600">{message}</p>
  : null;

const Toggle: React.FC<{
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}> = ({ checked, disabled, label, onChange }) => (
  <label className="inline-flex items-center gap-2 text-xs text-slate-600">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
    />
    {label}
  </label>
);

interface EditorProps {
  initial: SyntheticAgentConfig;
  poolIndex: number;
  agents: AgentConfig[];
  saving: boolean;
  readOnly: boolean;
  fieldErrors: Map<string, string>;
  onCancel: () => void;
  onSave: (draft: SyntheticAgentConfig) => Promise<boolean>;
}

const PoolEditor: React.FC<EditorProps> = ({
  initial, poolIndex, agents, saving, readOnly, fieldErrors, onCancel, onSave,
}) => {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [attemptedSave, setAttemptedSave] = useState(false);
  const pathError = (path: string) => fieldErrors.get(`${poolIndex}.${path}`);
  const physicalOptions = useMemo(() => agents.flatMap(agent =>
    agent.supportedModels.map(model => ({ agent, model, value: JSON.stringify([agent.alias, model]) }))), [agents]);

  const updateModel = (index: number, update: (model: SyntheticModelConfig) => SyntheticModelConfig) => {
    setDraft(current => ({
      ...current,
      models: current.models.map((model, modelIndex) => modelIndex === index ? update(model) : model),
    }));
  };

  const save = async () => {
    setAttemptedSave(true);
    await onSave(draft);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label="Synthetic pool editor">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-center gap-2">
            <Layers3 className="h-5 w-5 text-slate-600" />
            <h3 className="font-semibold text-slate-900">{initial.alias ? `Edit ${initial.alias}` : 'Create synthetic pool'}</h3>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close synthetic pool editor" className="text-slate-400 hover:text-slate-700"><X /></button>
        </div>

        <div className="space-y-5 p-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <label className="text-xs font-medium text-slate-700">
              Alias
              <input
                value={draft.alias}
                disabled={readOnly}
                onChange={event => setDraft({ ...draft, alias: event.target.value })}
                placeholder="team-coding-pool"
                className={`${inputClass} mt-1`}
              />
              <FieldError message={pathError('alias')} />
              {attemptedSave && !draft.alias && <FieldError message="Alias is required." />}
            </label>
            <div className="pt-6"><Toggle label="Pool enabled" checked={draft.enabled} disabled={readOnly} onChange={enabled => setDraft({ ...draft, enabled })} /></div>
          </div>

          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-900">
            Routing uses strict priority tiers: only eligible members at the highest available priority participate. Put primaries at priority 100 and fallbacks at priority 0 so fallback capacity is used only when every primary is ineligible or fails.
          </div>

          {draft.models.map((model, modelIndex) => (
            <section key={`${model.id}:${modelIndex}`} className="rounded-lg border border-slate-200">
              <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 bg-slate-50 p-3">
                <label className="min-w-40 flex-1 text-xs font-medium text-slate-700">
                  Virtual model ID
                  <input value={model.id} disabled={readOnly} onChange={event => {
                    const previousId = model.id;
                    const nextId = event.target.value;
                    setDraft(current => ({
                      ...current,
                      defaultModel: current.defaultModel === previousId ? nextId : current.defaultModel,
                      models: current.models.map((item, index) => index === modelIndex ? { ...item, id: nextId } : item),
                    }));
                  }} className={`${inputClass} mt-1`} />
                  <FieldError message={pathError(`models.${modelIndex}.id`)} />
                </label>
                <label className="min-w-40 flex-1 text-xs font-medium text-slate-700">
                  Display name (optional)
                  <input value={model.displayName ?? ''} disabled={readOnly} onChange={event => updateModel(modelIndex, current => ({ ...current, displayName: event.target.value || undefined }))} className={`${inputClass} mt-1`} />
                  <FieldError message={pathError(`models.${modelIndex}.displayName`)} />
                </label>
                <label className="min-w-36 text-xs font-medium text-slate-700">
                  Strategy
                  <select value={model.strategy} disabled={readOnly} onChange={event => updateModel(modelIndex, current => ({ ...current, strategy: event.target.value as SyntheticModelConfig['strategy'] }))} className={`${inputClass} mt-1`}>
                    <option value="round_robin">Round robin</option>
                    <option value="usage_based">Usage based</option>
                  </select>
                </label>
                <Toggle label="Enabled" checked={model.enabled} disabled={readOnly} onChange={enabled => updateModel(modelIndex, current => ({ ...current, enabled }))} />
                <Toggle label="Default" checked={draft.defaultModel === model.id} disabled={readOnly || !model.enabled} onChange={() => setDraft({ ...draft, defaultModel: model.id })} />
                <button type="button" disabled={readOnly || draft.models.length === 1} onClick={() => setDraft(current => ({ ...current, models: current.models.filter((_, index) => index !== modelIndex) }))} className="p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-30" aria-label={`Delete virtual model ${model.id}`}><Trash2 className="h-4 w-4" /></button>
              </div>

              <div className="space-y-3 p-3">
                {model.members.map((member, memberIndex) => {
                  const selected = JSON.stringify([member.directAgentAlias, member.model]);
                  return (
                    <div key={member.id} className="grid items-end gap-2 rounded-md border border-slate-200 p-3 lg:grid-cols-[minmax(220px,2fr)_80px_110px_110px_auto_auto]">
                      <label className="text-xs font-medium text-slate-700">
                        Direct agent / physical model
                        <select value={selected} disabled={readOnly} onChange={event => {
                          const [directAgentAlias, physicalModel] = JSON.parse(event.target.value) as [string, string];
                          updateModel(modelIndex, current => ({
                            ...current,
                            members: current.members.map((item, index) => index === memberIndex ? { ...item, directAgentAlias, model: physicalModel } : item),
                          }));
                        }} className={`${inputClass} mt-1`}>
                          {!physicalOptions.some(option => option.value === selected) && <option value={selected}>{member.directAgentAlias}:{member.model}</option>}
                          {physicalOptions.map(option => <option key={option.value} value={option.value}>{option.agent.alias} · {option.model}{option.agent.enabled ? '' : ' (agent disabled)'}</option>)}
                        </select>
                        <FieldError message={pathError(`models.${modelIndex}.members.${memberIndex}`) ?? pathError(`models.${modelIndex}.members.${memberIndex}.directAgentAlias`) ?? pathError(`models.${modelIndex}.members.${memberIndex}.model`)} />
                      </label>
                      <label className="text-xs font-medium text-slate-700">
                        Priority
                        <input type="number" min={0} max={100} value={member.priority} disabled={readOnly} onChange={event => updateModel(modelIndex, current => ({ ...current, members: current.members.map((item, index) => index === memberIndex ? { ...item, priority: Number(event.target.value) } : item) }))} className={`${inputClass} mt-1`} />
                        <FieldError message={pathError(`models.${modelIndex}.members.${memberIndex}.priority`)} />
                      </label>
                      <label className="text-xs font-medium text-slate-700">
                        Session cap %
                        <input type="number" min={1} max={100} value={member.usageLimits?.sessionMaxPercent ?? ''} disabled={readOnly} onChange={event => updateModel(modelIndex, current => ({ ...current, members: current.members.map((item, index) => index === memberIndex ? updateUsageLimit(item, 'sessionMaxPercent', event.target.value) : item) }))} className={`${inputClass} mt-1`} />
                        <FieldError message={pathError(`models.${modelIndex}.members.${memberIndex}.usageLimits.sessionMaxPercent`)} />
                      </label>
                      <label className="text-xs font-medium text-slate-700">
                        Weekly cap %
                        <input type="number" min={1} max={100} value={member.usageLimits?.weeklyMaxPercent ?? ''} disabled={readOnly} onChange={event => updateModel(modelIndex, current => ({ ...current, members: current.members.map((item, index) => index === memberIndex ? updateUsageLimit(item, 'weeklyMaxPercent', event.target.value) : item) }))} className={`${inputClass} mt-1`} />
                        <FieldError message={pathError(`models.${modelIndex}.members.${memberIndex}.usageLimits.weeklyMaxPercent`)} />
                      </label>
                      <Toggle label="Enabled" checked={member.enabled} disabled={readOnly} onChange={enabled => updateModel(modelIndex, current => ({ ...current, members: current.members.map((item, index) => index === memberIndex ? { ...item, enabled } : item) }))} />
                      <button type="button" disabled={readOnly || model.members.length === 1} onClick={() => updateModel(modelIndex, current => ({ ...current, members: current.members.filter((_, index) => index !== memberIndex) }))} className="p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-30" aria-label={`Delete member ${member.directAgentAlias} ${member.model}`}><Trash2 className="h-4 w-4" /></button>
                    </div>
                  );
                })}
                <button type="button" disabled={readOnly || physicalOptions.length === 0} onClick={() => updateModel(modelIndex, current => ({ ...current, members: [...current.members, newMember(agents)] }))} className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-900 disabled:text-slate-400"><Plus className="h-3.5 w-3.5" /> Add direct member</button>
              </div>
            </section>
          ))}

          <button type="button" disabled={readOnly} onClick={() => {
            let suffix = draft.models.length + 1;
            while (draft.models.some(model => model.id === `model-${suffix}`)) suffix += 1;
            setDraft(current => ({ ...current, models: [...current.models, newModel(agents, `model-${suffix}`)] }));
          }} className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:text-teal-900 disabled:text-slate-400"><Plus className="h-4 w-4" /> Add virtual model</button>

          {draft.models.some(model => model.members.some(member => member.usageLimits?.sessionMaxPercent !== undefined || member.usageLimits?.weeklyMaxPercent !== undefined)) && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              Usage caps require fresh Agent Tank data for the exact direct-agent alias. A capped member becomes ineligible when that alias-specific data is unavailable, refreshing, or stale; uncapped members do not require Agent Tank.
            </div>
          )}
          <FieldError message={pathError('defaultModel')} />
        </div>

        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white px-5 py-4">
          <button type="button" onClick={onCancel} className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="button" onClick={save} disabled={saving || readOnly || physicalOptions.length === 0} className="rounded bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:bg-slate-300">{saving ? 'Saving…' : 'Save pool'}</button>
        </div>
      </div>
    </div>
  );
};

const SyntheticPoolsSection: React.FC<SyntheticPoolsSectionProps> = ({
  agents, pools, loading, saving, error, warning, success, readOnly = false, readOnlyMessage, editorActive = true,
  addRequested = 0, onAddRequestConsumed, onSave,
}) => {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const fieldErrors = useMemo(() => parseFieldErrors(error), [error]);

  useEffect(() => {
    if (addRequested <= 0) return;
    onAddRequestConsumed?.(addRequested);
    if (!readOnly && editorActive) setCreating(true);
  }, [addRequested, editorActive, onAddRequestConsumed, readOnly]);

  useEffect(() => {
    if (!editorActive) {
      setCreating(false);
      setEditingIndex(null);
    }
  }, [editorActive]);

  const saveDraft = async (draft: SyntheticAgentConfig): Promise<boolean> => {
    const next = creating
      ? [...pools, draft]
      : pools.map((pool, index) => index === editingIndex ? draft : pool);
    const result = await onSave(next);
    if (!result) return false;
    setCreating(false);
    setEditingIndex(null);
    return true;
  };

  const mutate = async (next: SyntheticAgentConfig[]) => { await onSave(next); };

  return (
    <div>
      {readOnly && <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{readOnlyMessage ?? 'Demo mode is read-only. Synthetic pools can be inspected but not changed.'}</div>}
      {error && <Alert message={error} type="error" />}
      {warning && <Alert message={warning} type="warning" />}
      {success && <Alert message={success} type="success" />}
      {loading ? <p className="text-sm text-slate-600">Loading synthetic pools…</p> : (
        <div className="divide-y divide-slate-100">
          {pools.map((pool, index) => (
            <div key={pool.id} className="py-4 first:pt-0">
              <div className="flex items-center justify-between gap-3">
                <button type="button" onClick={() => setEditingIndex(index)} className="flex min-w-0 items-center gap-2 text-left">
                  <span className="rounded-md bg-slate-100 p-1.5"><Layers3 className="h-4 w-4 text-slate-600" /></span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-900">{pool.alias}</span>
                    <span className="block text-xs text-slate-500">{pool.models.length} virtual model{pool.models.length === 1 ? '' : 's'} · default {pool.defaultModel}</span>
                  </span>
                </button>
                <div className="flex items-center gap-2">
                  <Toggle label={pool.enabled ? 'Enabled' : 'Disabled'} checked={pool.enabled} disabled={readOnly || saving} onChange={enabled => mutate(pools.map(item => item.id === pool.id ? { ...item, enabled } : item))} />
                  <button type="button" disabled={readOnly || saving} onClick={() => { if (confirm(`Delete synthetic pool "${pool.alias}"?`)) void mutate(pools.filter(item => item.id !== pool.id)); }} className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-30" aria-label={`Delete synthetic pool ${pool.alias}`}><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="ml-9 mt-2 flex flex-wrap gap-1.5">
                {pool.models.map(model => <span key={model.id} className={`rounded-full border px-2 py-0.5 text-[10px] ${model.enabled ? 'border-slate-200 bg-white text-slate-600' : 'border-slate-100 bg-slate-50 text-slate-400'}`}>{model.displayName || model.id} · {model.strategy === 'round_robin' ? 'Round robin' : 'Usage based'} · {model.members.length} members</span>)}
              </div>
            </div>
          ))}
          {pools.length === 0 && <div className="py-12 text-center"><Layers3 className="mx-auto mb-3 h-9 w-9 text-slate-300" /><h3 className="font-medium text-slate-900">No synthetic pools</h3><p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">Combine direct agent accounts and models behind a stable virtual model with routing, caps, and failover.</p><button type="button" disabled={readOnly || agents.every(agent => agent.supportedModels.length === 0)} onClick={() => setCreating(true)} className="mt-4 rounded bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:bg-slate-300">Create synthetic pool</button></div>}
        </div>
      )}
      {saving && <p className="mt-3 text-sm text-slate-500">Saving synthetic pools…</p>}
      {editorActive && (creating || editingIndex !== null) && (
        <PoolEditor
          initial={creating ? newPool(agents) : pools[editingIndex!]}
          poolIndex={creating ? pools.length : editingIndex!}
          agents={agents}
          saving={saving}
          readOnly={readOnly}
          fieldErrors={fieldErrors}
          onCancel={() => { setCreating(false); setEditingIndex(null); }}
          onSave={saveDraft}
        />
      )}
    </div>
  );
};

export default SyntheticPoolsSection;
