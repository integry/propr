import React from 'react';
import { formatModelName } from '../../utils/modelDisplay';
import { SettingsField } from './SettingsLayout';
import type { buildAllModelOptions } from './modelSelectionHelpers';
import { SETTINGS_CONTROL } from './settingsStyles';

interface EscalationModelListFieldProps {
  /** Prefix of the select IDs: `<idPrefix>_<index>` and `<idPrefix>_add`. */
  idPrefix: string;
  /** Accessible name of each select, e.g. "Escalation model" → "Escalation model 1". */
  ariaLabel: string;
  label: string;
  helperText: string;
  models: string[];
  modelOptions: ReturnType<typeof buildAllModelOptions>;
  onChange: (models: string[]) => void;
}

/** Ordered escalation models: each row picks one model; the last select appends another. */
const EscalationModelListField: React.FC<EscalationModelListFieldProps> = ({ idPrefix, ariaLabel, label, helperText, models, modelOptions, onChange }) => {
  const lowerLabel = ariaLabel.charAt(0).toLowerCase() + ariaLabel.slice(1);
  return (
    <SettingsField label={label} htmlFor={models.length ? `${idPrefix}_0` : `${idPrefix}_add`} helperText={helperText}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2">
        {models.map((model, index) => (
          <div key={index} className="contents">
            <span className="text-sm text-gray-500">{index + 1}.</span>
            <select id={`${idPrefix}_${index}`} aria-label={`${ariaLabel} ${index + 1}`}
              value={model} className={`${SETTINGS_CONTROL} min-w-0`}
              onChange={event => onChange(models.map((value, i) => i === index ? event.target.value : value))}>
              {!modelOptions.some(option => option.value === model) && <option value={model}>{formatModelName(model)} (unavailable)</option>}
              {modelOptions.map(option => <option key={option.value} value={option.value}>
                {option.label}{option.enabled ? '' : ' (disabled)'}
              </option>)}
            </select>
            <button type="button" aria-label={`Remove ${lowerLabel} ${index + 1}`}
              onClick={() => onChange(models.filter((_, i) => i !== index))}
              className="text-sm text-gray-600 hover:text-gray-900">Remove</button>
          </div>
        ))}
        <select id={`${idPrefix}_add`} aria-label={`Add ${lowerLabel}`} value="" className={`${SETTINGS_CONTROL} col-start-2 min-w-0`}
          onChange={event => { if (event.target.value) onChange([...models, event.target.value]); }}>
          <option value="">Add {lowerLabel}…</option>
          {modelOptions.map(option => <option key={option.value} value={option.value}>
            {option.label}{option.enabled ? '' : ' (disabled)'}
          </option>)}
        </select>
      </div>
    </SettingsField>
  );
};

export default EscalationModelListField;
