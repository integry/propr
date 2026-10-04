import type React from 'react';
import { DEFAULT_USAGE_TIPS_COOLDOWN_DAYS } from '@propr/shared';
import { SettingsCheckboxField, SettingsField, SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';
import type { Settings } from './types';

export function UsageTipsSettingsSection({ settings, onChange, onBlur }: {
  settings: Pick<Settings, 'usage_tips_enabled' | 'usage_tips_dismissal_cooldown_days'>;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
}) {
  return <SettingsSection title="Usage tips" description="Daily documentation tips beneath dashboard statistics. Display history is never tracked.">
    <SettingsCheckboxField id="usage_tips_enabled" name="usage_tips_enabled" label="Show usage tips"
      checked={settings.usage_tips_enabled ?? true} onChange={onChange} onBlur={onBlur} />
    <SettingsField label="Dismissal cooldown days" htmlFor="usage_tips_dismissal_cooldown_days"
      helperText="1–365 days. Each repeat dismissal multiplies the period by four, up to 3,650 days. Changing this value recalculates existing cooldowns from their last dismissal.">
      <input id="usage_tips_dismissal_cooldown_days" name="usage_tips_dismissal_cooldown_days" type="number" min={1} max={365} step={1}
        className={SETTINGS_CONTROL} value={settings.usage_tips_dismissal_cooldown_days ?? DEFAULT_USAGE_TIPS_COOLDOWN_DAYS}
        onChange={onChange} onBlur={onBlur} />
    </SettingsField>
  </SettingsSection>;
}
