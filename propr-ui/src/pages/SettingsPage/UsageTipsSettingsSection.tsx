import type React from 'react';
import { USAGE_TIP_DISMISSAL_COOLDOWN_DAYS } from '@propr/shared';
import { SettingsCheckboxField, SettingsSection } from './SettingsLayout';
import type { Settings } from './types';

export function UsageTipsSettingsSection({ settings, onChange, onBlur }: {
  settings: Pick<Settings, 'usage_tips_enabled'>;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
}) {
  return <SettingsSection title="Usage tips" description={`Daily documentation tips beneath dashboard statistics. A dismissed tip stays hidden for ${USAGE_TIP_DISMISSAL_COOLDOWN_DAYS} days. Display history is never tracked.`}>
    <SettingsCheckboxField id="usage_tips_enabled" name="usage_tips_enabled" label="Show usage tips"
      checked={settings.usage_tips_enabled ?? true} onChange={onChange} onBlur={onBlur} />
  </SettingsSection>;
}
