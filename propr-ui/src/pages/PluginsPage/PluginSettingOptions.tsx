import type { SelectHTMLAttributes } from 'react';
import { buttonClass } from './pluginUi';
import type { SettingOptions } from './usePluginSettingOptions';

/** Loading, the refusal and the action that loads the choices again. */
export function SettingOptionsStatus({ label, options, disabled }: { label: string; options: SettingOptions; disabled: boolean }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      {options.status === 'loading' && <span data-testid="plugin-setting-options-loading" className="text-slate-500">Loading the choices…</span>}
      {options.status === 'loaded' && options.options.length === 0 && <span className="text-slate-500">The service listed no choices.</span>}
      {options.status === 'error' && (
        <span role="alert" data-testid="plugin-setting-options-error" className="font-medium text-red-700 [overflow-wrap:anywhere]">
          Could not load the choices: {options.error}
        </span>
      )}
      <button type="button" className={buttonClass} disabled={disabled || options.status === 'loading'} onClick={options.reload}
        aria-label={`Load the choices of ${label} again`}>Reload choices</button>
    </div>
  );
}

/** A select of the loaded choices, with Not set, and a saved value the service no longer lists kept as its own choice. */
export function SettingOptionsSelect({ value, options, onChange, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> & {
  value: string; options: SettingOptions; onChange: (value: string) => void;
}) {
  const listed = options.options.some(option => option.value === value);
  return (
    <select {...rest} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">Not set</option>
      {value && !listed && <option value={value}>{options.status === 'loaded' ? `${value} (not listed by the service)` : value}</option>}
      {options.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}
