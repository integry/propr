import React, { useMemo, useState } from 'react';
import type { InstanceCatalogAgent } from '@propr/shared';
import type { ScheduleInput, ScheduleInstruction, TaskSchedule } from '../../../api/scheduleApi';
import { RepositorySelector } from '../../../components/RepositorySelector';
import { SettingsCheckboxField, SettingsField } from '../SettingsLayout';
import { SETTINGS_CONTROL } from '../settingsStyles';
import { CRON_PRESETS, browserTimeZone, errorMessage, knownTimeZones } from './scheduleFormat';

interface ScheduleFormValues {
  name: string;
  repository: string;
  cron: string;
  timezone: string;
  text: string;
  agentAlias: string;
  model: string;
  runUltrafix: boolean;
  autoMerge: boolean;
  maxCostUsd: string;
}

const initialValues = (): ScheduleFormValues => ({
  name: '', repository: '', cron: CRON_PRESETS[0].cron, timezone: browserTimeZone(), text: '',
  agentAlias: '', model: '', runUltrafix: false, autoMerge: false, maxCostUsd: '',
});

/** The REST body for a new schedule; returns an error message when the form cannot be sent. */
// eslint-disable-next-line react-refresh/only-export-components
export function scheduleInputFromForm(values: ScheduleFormValues): ScheduleInput | string {
  if (!values.repository) return 'Choose a repository.';
  if (!values.cron.trim()) return 'Enter a cron expression.';
  if (!values.timezone.trim()) return 'Enter a time zone.';
  if (!values.text.trim()) return 'Enter the instruction the schedule should run.';
  const instruction: ScheduleInstruction = { text: values.text.trim() };
  if (values.agentAlias) instruction.agentAlias = values.agentAlias;
  if (values.agentAlias && values.model) instruction.model = values.model;
  if (values.runUltrafix) instruction.runUltrafix = true;
  if (values.autoMerge) instruction.autoMerge = true;
  const cost = values.maxCostUsd.trim();
  if (cost) {
    const amount = Number(cost);
    if (!Number.isFinite(amount) || amount < 0) return 'Max cost must be a non-negative USD amount.';
    if (amount > 0) instruction.maxCostUsd = amount;
  }
  return {
    ...(values.name.trim() ? { name: values.name.trim() } : {}),
    repository: values.repository,
    cron: values.cron.trim(),
    timezone: values.timezone.trim(),
    instruction,
  };
}

const PRESET_BUTTON = 'rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 aria-pressed:border-teal-500 aria-pressed:bg-teal-50 aria-pressed:text-teal-800';

export function ScheduleCreateForm({ agents, onCreate, onCancel }: {
  agents: InstanceCatalogAgent[];
  onCreate(input: ScheduleInput): Promise<TaskSchedule>;
  onCancel(): void;
}) {
  const [values, setValues] = useState<ScheduleFormValues>(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timeZones = useMemo(knownTimeZones, []);
  const selectedAgent = agents.find(agent => agent.alias === values.agentAlias);
  const set = <K extends keyof ScheduleFormValues>(key: K, value: ScheduleFormValues[K]) =>
    setValues(current => ({ ...current, [key]: value }));
  const onText = (key: 'name' | 'cron' | 'timezone' | 'text' | 'maxCostUsd') =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(key, event.target.value);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const input = scheduleInputFromForm(values);
    if (typeof input === 'string') { setError(input); return; }
    setSaving(true);
    setError(null);
    try {
      await onCreate(input);
      setValues(initialValues());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form aria-label="New scheduled task" onSubmit={event => void submit(event)} className="mt-6 max-w-2xl rounded border border-slate-200 bg-slate-50/60 p-4">
      <h5 className="mb-4 text-sm font-semibold text-slate-900">New scheduled task</h5>
      <SettingsField label="Name" htmlFor="schedule-name" helperText="Optional. Defaults to the first line of the instruction.">
        <input id="schedule-name" className={SETTINGS_CONTROL} value={values.name} maxLength={200} onChange={onText('name')} placeholder="Nightly dependency check" />
      </SettingsField>
      <div className="mb-6">
        <span className="block text-sm font-medium text-slate-900" id="schedule-repository-label">Repository</span>
        <div className="mt-1.5">
          <RepositorySelector selectedRepo={values.repository} onRepoChange={repo => set('repository', repo)} placeholder="Select a repository" />
        </div>
      </div>
      <SettingsField label="Cron expression" htmlFor="schedule-cron"
        helperText="Five fields: minute hour day-of-month month day-of-week. Runs at most every 5 minutes.">
        <input id="schedule-cron" className={`${SETTINGS_CONTROL} font-mono`} value={values.cron} onChange={onText('cron')} placeholder="0 2 * * *" />
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Cron presets">
          {CRON_PRESETS.map(preset => (
            <button key={preset.cron} type="button" className={PRESET_BUTTON} aria-pressed={values.cron.trim() === preset.cron}
              onClick={() => set('cron', preset.cron)}>{preset.label}</button>
          ))}
        </div>
      </SettingsField>
      <SettingsField label="Time zone" htmlFor="schedule-timezone" helperText="IANA time zone the cron expression is evaluated in.">
        <input id="schedule-timezone" className={SETTINGS_CONTROL} value={values.timezone} onChange={onText('timezone')} list="schedule-timezones" />
        {timeZones.length > 0 && <datalist id="schedule-timezones">{timeZones.map(zone => <option key={zone} value={zone} />)}</datalist>}
      </SettingsField>
      <SettingsField label="Instruction" htmlFor="schedule-instruction" helperText="Submitted as a new task each time the schedule fires.">
        <textarea id="schedule-instruction" className={SETTINGS_CONTROL} rows={4} maxLength={50000} value={values.text} onChange={onText('text')}
          placeholder="Update outdated dependencies and open a pull request." />
      </SettingsField>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <SettingsField label="Agent" htmlFor="schedule-agent">
          <select id="schedule-agent" className={SETTINGS_CONTROL} value={values.agentAlias}
            onChange={event => setValues(current => ({ ...current, agentAlias: event.target.value, model: '' }))}>
            <option value="">Instance default</option>
            {agents.map(agent => <option key={agent.alias} value={agent.alias}>{agent.alias}</option>)}
          </select>
        </SettingsField>
        <SettingsField label="Model" htmlFor="schedule-model">
          <select id="schedule-model" className={SETTINGS_CONTROL} value={values.model} disabled={!selectedAgent}
            onChange={event => set('model', event.target.value)}>
            <option value="">Agent default</option>
            {selectedAgent?.supportedModels.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </SettingsField>
      </div>
      <SettingsCheckboxField id="schedule-run-ultrafix" label="Run Ultrafix" checked={values.runUltrafix}
        helperText="Review and fix the pull request until it reaches the instance rating goal."
        onChange={event => set('runUltrafix', event.target.checked)} />
      <SettingsCheckboxField id="schedule-auto-merge" label="Auto-merge" checked={values.autoMerge}
        helperText="Merge the pull request automatically when it passes."
        onChange={event => set('autoMerge', event.target.checked)} />
      <SettingsField label="Max cost (USD)" htmlFor="schedule-max-cost" helperText="Optional per-run spend cap. Empty uses the repository or instance cap.">
        <input id="schedule-max-cost" type="number" min={0} step="0.01" inputMode="decimal" className={SETTINGS_CONTROL}
          value={values.maxCostUsd} onChange={onText('maxCostUsd')} placeholder="5.00" />
      </SettingsField>
      {error && <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="rounded bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
          {saving ? 'Creating…' : 'Create schedule'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving} className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
          Cancel
        </button>
      </div>
    </form>
  );
}
