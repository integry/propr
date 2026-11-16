import { useId, type ReactNode } from 'react';
import type { PluginSetting } from '@propr/shared';
import { buttonClass, inputClass } from './pluginUi';
import type { CollectionDraft, RepositoryMapRow, SettingDraft } from './pluginSettingsUi';
import { SettingOptionsSelect, SettingOptionsStatus } from './PluginSettingOptions';
import { useSettingOptions, type SettingOptions } from './usePluginSettingOptions';

export interface SettingFieldProps {
  name: string;
  setting: PluginSetting;
  draft: SettingDraft;
  required: boolean;
  error?: string;
  disabled: boolean;
  /** Repositories this instance manages, suggested as repository map keys. */
  repositories: string[];
  onChange: (draft: SettingDraft) => void;
  /** The plugin, for the choices of an `optionsFrom` setting. */
  pluginId?: string;
}

const invalidClass = 'border-red-500 ring-1 ring-red-500';

/** The label, help, required note and error of one field; manifest text is shown as plain text only. */
function FieldText({ setting, required, helpId, errorId, error }: { setting: PluginSetting; required: boolean; helpId: string; errorId: string; error?: string }) {
  return (
    <>
      {(setting.help || required) && (
        <span id={helpId} className="mt-1 block text-xs text-slate-500">
          {setting.help}{setting.help && required ? ' ' : ''}{required && <span className="font-medium text-slate-700">Required to enable.</span>}
        </span>
      )}
      {error && <span id={errorId} data-testid="plugin-setting-error" className="mt-1 block text-xs font-medium text-red-700 [overflow-wrap:anywhere]">{error}</span>}
    </>
  );
}

function useFieldIds(error?: string) {
  const base = useId();
  const helpId = `${base}-help`;
  const errorId = `${base}-error`;
  return { id: base, helpId, errorId, describedBy: [helpId, error ? errorId : ''].filter(Boolean).join(' '), invalid: Boolean(error) };
}

function hint(setting: PluginSetting): string {
  if (setting.type === 'string' && setting.format === 'https-url') return 'An https:// URL on a public host';
  if (setting.type === 'number') {
    const range = [setting.minimum !== undefined ? `at least ${setting.minimum}` : '', setting.maximum !== undefined ? `at most ${setting.maximum}` : ''].filter(Boolean).join(', ');
    return [setting.integer ? 'A whole number' : 'A number', range].filter(Boolean).join(', ');
  }
  return '';
}

function Labelled({ setting, required, ids, error, children }: { setting: PluginSetting; required: boolean; ids: ReturnType<typeof useFieldIds>; error?: string; children: ReactNode }) {
  const extra = hint(setting);
  return (
    <div className="text-sm">
      <label htmlFor={ids.id} className="font-medium text-slate-900 [overflow-wrap:anywhere]">{setting.label}</label>
      {children}
      {extra && <span className="mt-1 block text-xs text-slate-500">{extra}</span>}
      <FieldText setting={setting} required={required} helpId={ids.helpId} errorId={ids.errorId} error={error} />
    </div>
  );
}

/** Whether a list or map is unset, set but empty, or has entries, and the action that removes the setting. */
function CollectionState({ label, draft, empty, disabled, onChange }: { label: string; draft: CollectionDraft<unknown>; empty: string; disabled: boolean; onChange: (draft: CollectionDraft<never>) => void }) {
  if (!draft.set && draft.rows.length === 0) return <p data-testid="plugin-setting-state" className="mt-1 text-xs text-slate-500">Not set.</p>;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {draft.rows.length === 0 && <p data-testid="plugin-setting-state" className="text-xs text-slate-500">{empty}</p>}
      <button type="button" className={buttonClass} disabled={disabled} onClick={() => onChange({ set: false, rows: [] })}>Clear {label}</button>
    </div>
  );
}

const lineCount = (text: string) => Math.max(1, text.split('\n').length);

function ListField({ setting, draft, required, error, disabled, onChange }: SettingFieldProps) {
  const ids = useFieldIds(error);
  const list = draft as CollectionDraft<string>;
  const max = setting.type === 'array' ? setting.maxItems : undefined;
  const rows = (next: string[]) => onChange({ set: true, rows: next });
  return (
    <fieldset className="min-w-0 text-sm" aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined}>
      <legend className="font-medium text-slate-900 [overflow-wrap:anywhere]">{setting.label}</legend>
      <span className="block text-xs text-slate-500">One entry per box{max ? `, up to ${max}` : ''}; each is saved exactly as typed.</span>
      <CollectionState label={setting.label} draft={list} empty="Empty list." disabled={disabled} onChange={onChange} />
      <ul className="mt-1 space-y-2">
        {list.rows.map((entry, index) => (
          <li key={index} className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <textarea className={`${inputClass} mt-0 sm:flex-1 ${error ? invalidClass : ''}`} rows={lineCount(entry)} value={entry} disabled={disabled}
              aria-label={`${setting.label}: entry ${index + 1}`} onChange={event => rows(list.rows.map((item, i) => (i === index ? event.target.value : item)))} />
            <button type="button" className={buttonClass} disabled={disabled} aria-label={`Remove entry ${index + 1} from ${setting.label}`}
              onClick={() => rows(list.rows.filter((_, i) => i !== index))}>Remove</button>
          </li>
        ))}
      </ul>
      <button type="button" className={`${buttonClass} mt-2`} disabled={disabled} onClick={() => rows([...list.rows, ''])}>
        Add entry to {setting.label}
      </button>
      <FieldText setting={setting} required={required} helpId={ids.helpId} errorId={ids.errorId} error={error} />
    </fieldset>
  );
}

/** A list whose entries come from a fixed set (`items.enum`): one checkbox per value, saved in the manifest's order. */
function ChoiceListField({ setting, draft, required, error, disabled, onChange }: SettingFieldProps) {
  const ids = useFieldIds(error);
  const list = draft as CollectionDraft<string>;
  const choices = setting.type === 'array' ? setting.items.enum ?? [] : [];
  const toggle = (value: string, checked: boolean) => {
    const next = new Set(list.rows.filter(row => row !== value));
    if (checked) next.add(value);
    // Values the manifest no longer offers stay as they are, so validation names them.
    onChange({ set: true, rows: [...choices.filter(choice => next.has(choice)), ...[...next].filter(row => !choices.includes(row))] });
  };
  return (
    <fieldset className="min-w-0 text-sm" aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined}>
      <legend className="font-medium text-slate-900 [overflow-wrap:anywhere]">{setting.label}</legend>
      <span className="block text-xs text-slate-500">Choose any number.</span>
      <CollectionState label={setting.label} draft={list} empty="None chosen." disabled={disabled} onChange={onChange} />
      <ul className="mt-1 grid gap-1 sm:grid-cols-2">
        {choices.map(choice => (
          <li key={choice}>
            <label className="flex min-w-0 items-center gap-2">
              <input type="checkbox" className="h-4 w-4 shrink-0" checked={list.rows.includes(choice)} disabled={disabled}
                onChange={event => toggle(choice, event.target.checked)} />
              <code className="text-xs text-slate-800 [overflow-wrap:anywhere]">{choice}</code>
            </label>
          </li>
        ))}
      </ul>
      <FieldText setting={setting} required={required} helpId={ids.helpId} errorId={ids.errorId} error={error} />
    </fieldset>
  );
}

function RepositoryMapField({ setting, draft, required, error, disabled, repositories, onChange, choices }: SettingFieldProps & { choices?: SettingOptions }) {
  const ids = useFieldIds(error);
  const map = draft as CollectionDraft<RepositoryMapRow>;
  const rows = map.rows;
  const listId = `${ids.id}-repositories`;
  const set = (next: RepositoryMapRow[]) => onChange({ set: true, rows: next });
  const update = (index: number, patch: Partial<RepositoryMapRow>) => set(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="min-w-0 text-sm" aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined}>
      <legend className="font-medium text-slate-900 [overflow-wrap:anywhere]">{setting.label}</legend>
      <span className="block text-xs text-slate-500">Maps a repository (owner/name) to a value{choices ? ' chosen from the service' : ''}.</span>
      {choices && <SettingOptionsStatus label={setting.label} options={choices} disabled={disabled} />}
      <datalist id={listId}>{repositories.map(name => <option key={name} value={name} />)}</datalist>
      <CollectionState label={setting.label} draft={map} empty="No repositories yet." disabled={disabled} onChange={onChange} />
      <ul className="mt-1 space-y-2">
        {rows.map((row, index) => (
          <li key={index} className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <input className={`${inputClass} mt-0 sm:flex-1 ${error ? invalidClass : ''}`} list={listId} value={row.repository} disabled={disabled}
              aria-label={`${setting.label}: repository ${index + 1}`} placeholder="owner/name" onChange={event => update(index, { repository: event.target.value })} />
            {choices
              ? <SettingOptionsSelect className={`${inputClass} mt-0 sm:flex-1 ${error ? invalidClass : ''}`} value={row.text} options={choices} disabled={disabled}
                aria-label={`${setting.label}: value for repository ${index + 1}`} onChange={text => update(index, { text })} />
              : <input className={`${inputClass} mt-0 sm:flex-1 ${error ? invalidClass : ''}`} value={row.text} disabled={disabled}
                aria-label={`${setting.label}: value for repository ${index + 1}`} onChange={event => update(index, { text: event.target.value })} />}
            <button type="button" className={buttonClass} disabled={disabled} aria-label={`Remove repository ${index + 1} from ${setting.label}`}
              onClick={() => set(rows.filter((_, i) => i !== index))}>Remove</button>
          </li>
        ))}
      </ul>
      <button type="button" className={`${buttonClass} mt-2`} disabled={disabled} onClick={() => set([...rows, { repository: '', text: '' }])}>
        Add repository to {setting.label}
      </button>
      <FieldText setting={setting} required={required} helpId={ids.helpId} errorId={ids.errorId} error={error} />
    </fieldset>
  );
}

function ValueField(props: SettingFieldProps & { choices?: SettingOptions }) {
  const { setting, draft, required, error, disabled, onChange, choices } = props;
  const ids = useFieldIds(error);
  const common = {
    id: ids.id, disabled, 'aria-describedby': ids.describedBy, 'aria-invalid': ids.invalid || undefined,
    className: `${inputClass} ${error ? invalidClass : ''}`,
  };
  let control: ReactNode;
  if (setting.type === 'boolean') {
    // Not set is its own choice, so an explicit "No" (false) can be saved and an existing value can be removed.
    control = (
      <select {...common} value={String(draft)} onChange={event => onChange(event.target.value)}>
        <option value="">Not set</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  } else if (choices) {
    control = <SettingOptionsSelect {...common} value={String(draft)} options={choices} onChange={onChange} />;
  } else if (setting.type === 'string' && setting.enum) {
    control = (
      <select {...common} value={String(draft)} onChange={event => onChange(event.target.value)}>
        <option value="">Not set</option>
        {setting.enum.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  } else if (setting.type === 'number') {
    control = <input {...common} type="number" inputMode="decimal" step={setting.integer ? 1 : 'any'} min={setting.minimum} max={setting.maximum}
      value={String(draft)} onChange={event => onChange(event.target.value)} />;
  } else if (setting.type === 'string' && setting.format === 'https-url') {
    control = <input {...common} type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://" maxLength={setting.maxLength}
      value={String(draft)} onChange={event => onChange(event.target.value)} />;
  } else {
    control = <input {...common} type="text" maxLength={setting.type === 'string' ? setting.maxLength : undefined} value={String(draft)} onChange={event => onChange(event.target.value)} />;
  }
  return (
    <Labelled setting={setting} required={required} ids={ids} error={error}>
      {control}
      {choices && <SettingOptionsStatus label={setting.label} options={choices} disabled={disabled} />}
    </Labelled>
  );
}

/** A string or repository map setting whose choices the plugin lists (`optionsFrom`), loaded when it is shown. */
function OptionsField(props: SettingFieldProps & { pluginId: string }) {
  const choices = useSettingOptions(props.pluginId, props.name);
  return props.setting.type === 'object' ? <RepositoryMapField {...props} choices={choices} /> : <ValueField {...props} choices={choices} />;
}

/** One generated field: text, URL, number, select (a choice list, choices the plugin loads from the service, or Not set / Yes / No), list, multiple choice or repository map, chosen from the setting's schema. */
export function PluginSettingField(props: SettingFieldProps) {
  const { setting, pluginId } = props;
  if (pluginId && (setting.type === 'string' || setting.type === 'object') && setting.optionsFrom) return <OptionsField {...props} pluginId={pluginId} />;
  if (props.setting.type === 'array') return props.setting.items.enum ? <ChoiceListField {...props} /> : <ListField {...props} />;
  if (props.setting.type === 'object') return <RepositoryMapField {...props} />;
  return <ValueField {...props} />;
}
