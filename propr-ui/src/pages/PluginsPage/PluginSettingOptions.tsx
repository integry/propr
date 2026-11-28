import { buttonClass } from './pluginUi';
import type { SettingChoice, SettingChoices } from './usePluginSettingChoices';

/** The status line of loaded choices, with Reload choices; a refusal is shown as an alert and the field falls back to typing. */
export function SettingChoicesStatus({ label, choices, disabled, onReload }: { label: string; choices: SettingChoices; disabled: boolean; onReload: () => void }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="plugin-setting-choices">
      {choices.state === 'loading' && <span role="status" className="text-xs text-slate-500">Loading choices…</span>}
      {choices.state === 'loaded' && <span className="text-xs text-slate-500">{choices.options.length ? `${choices.options.length} choices from the service.` : 'The service offered no choices.'}</span>}
      {choices.state === 'failed' && (
        <span role="alert" data-testid="plugin-setting-choices-error" className="text-xs font-medium text-red-700 [overflow-wrap:anywhere]">
          Choices could not be loaded: {choices.error} You can still type a value.
        </span>
      )}
      <button type="button" className={buttonClass} disabled={disabled || choices.state === 'loading'} onClick={onReload} aria-label={`Reload choices for ${label}`}>Reload choices</button>
    </div>
  );
}

/** The options of a select of loaded choices: Not set, the choices, and a saved value the service no longer offers (kept, so saving does not drop it). */
export function ChoiceOptions({ options, value }: { options: SettingChoice[]; value: string }) {
  const offered = options.some(option => option.value === value);
  return (
    <>
      <option value="">Not set</option>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      {value && !offered && <option value={value}>{value} (not offered by the service)</option>}
    </>
  );
}
