import { useId, type ReactNode } from 'react';
import type { PluginSetting } from '@propr/shared';
import { buttonClass, inputClass } from './pluginUi';
import type { RepositoryMapRow, SettingDraft } from './pluginSettingsUi';

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
  if (setting.type === 'number') {
    const range = [setting.minimum !== undefined ? `at least ${setting.minimum}` : '', setting.maximum !== undefined ? `at most ${setting.maximum}` : ''].filter(Boolean).join(', ');
    return [setting.integer ? 'A whole number' : 'A number', range].filter(Boolean).join(', ');
  }
  if (setting.type === 'array') return `One entry per line${setting.maxItems ? `, up to ${setting.maxItems}` : ''}.`;
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

function RepositoryMapField({ setting, draft, required, error, disabled, repositories, onChange }: SettingFieldProps) {
  const ids = useFieldIds(error);
  const rows = draft as RepositoryMapRow[];
  const listId = `${ids.id}-repositories`;
  const update = (index: number, patch: Partial<RepositoryMapRow>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="min-w-0 text-sm" aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined}>
      <legend className="font-medium text-slate-900 [overflow-wrap:anywhere]">{setting.label}</legend>
      <span className="block text-xs text-slate-500">Maps a repository (owner/name) to a value.</span>
      <datalist id={listId}>{repositories.map(name => <option key={name} value={name} />)}</datalist>
      {rows.length === 0 && <p className="mt-1 text-xs text-slate-500">No repositories yet.</p>}
      <ul className="mt-1 space-y-2">
        {rows.map((row, index) => (
          <li key={index} className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <input className={`${inputClass} mt-0 sm:flex-1 ${error ? invalidClass : ''}`} list={listId} value={row.repository} disabled={disabled}
              aria-label={`${setting.label}: repository ${index + 1}`} placeholder="owner/name" onChange={event => update(index, { repository: event.target.value })} />
            <input className={`${inputClass} mt-0 sm:flex-1 ${error ? invalidClass : ''}`} value={row.text} disabled={disabled}
              aria-label={`${setting.label}: value for repository ${index + 1}`} onChange={event => update(index, { text: event.target.value })} />
            <button type="button" className={buttonClass} disabled={disabled} aria-label={`Remove repository ${index + 1} from ${setting.label}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}>Remove</button>
          </li>
        ))}
      </ul>
      <button type="button" className={`${buttonClass} mt-2`} disabled={disabled} onClick={() => onChange([...rows, { repository: '', text: '' }])}>
        Add repository to {setting.label}
      </button>
      <FieldText setting={setting} required={required} helpId={ids.helpId} errorId={ids.errorId} error={error} />
    </fieldset>
  );
}

function CheckboxField({ setting, draft, required, error, disabled, onChange }: SettingFieldProps) {
  const ids = useFieldIds(error);
  return (
    <div className="text-sm">
      <label className="flex items-start gap-2">
        <input id={ids.id} type="checkbox" className="mt-1" checked={draft === true} disabled={disabled}
          aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} onChange={event => onChange(event.target.checked)} />
        <span className="font-medium text-slate-900 [overflow-wrap:anywhere]">{setting.label}</span>
      </label>
      <div className="pl-6"><FieldText setting={setting} required={required} helpId={ids.helpId} errorId={ids.errorId} error={error} /></div>
    </div>
  );
}

function ValueField(props: SettingFieldProps) {
  const { setting, draft, required, error, disabled, onChange } = props;
  const ids = useFieldIds(error);
  const common = {
    id: ids.id, disabled, 'aria-describedby': ids.describedBy, 'aria-invalid': ids.invalid || undefined,
    className: `${inputClass} ${error ? invalidClass : ''}`,
  };
  let control: ReactNode;
  if (setting.type === 'string' && setting.enum) {
    control = (
      <select {...common} value={String(draft)} onChange={event => onChange(event.target.value)}>
        <option value="">Not set</option>
        {setting.enum.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  } else if (setting.type === 'array') {
    control = <textarea {...common} rows={3} value={String(draft)} onChange={event => onChange(event.target.value)} />;
  } else if (setting.type === 'number') {
    control = <input {...common} type="number" inputMode="decimal" step={setting.integer ? 1 : 'any'} min={setting.minimum} max={setting.maximum}
      value={String(draft)} onChange={event => onChange(event.target.value)} />;
  } else {
    control = <input {...common} type="text" maxLength={setting.type === 'string' ? setting.maxLength : undefined} value={String(draft)} onChange={event => onChange(event.target.value)} />;
  }
  return <Labelled setting={setting} required={required} ids={ids} error={error}>{control}</Labelled>;
}

/** One generated field: text, number, checkbox, select, list or repository map, chosen from the setting's schema. */
export function PluginSettingField(props: SettingFieldProps) {
  if (props.setting.type === 'boolean') return <CheckboxField {...props} />;
  if (props.setting.type === 'object') return <RepositoryMapField {...props} />;
  return <ValueField {...props} />;
}
