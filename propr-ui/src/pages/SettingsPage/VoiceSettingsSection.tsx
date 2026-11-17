import { useState } from 'react';
import { useVoicePreference } from '../../hooks/useVoicePreference';
import { SettingsSection } from './SettingsLayout';
import { SETTINGS_CHECKBOX, SETTINGS_LABEL } from './settingsStyles';

/** The voice briefings opt-in, shared by the account settings and the instance Experimental section. */
export function VoiceBriefingsToggle() {
  const preference = useVoicePreference();
  const [error, setError] = useState<{ key: string | null; message: string } | null>(null);
  return (
    <div className="mb-6 flex max-w-2xl items-start gap-3">
      <input
        type="checkbox"
        id="voice-briefings-enabled"
        checked={preference.enabled}
        disabled={!preference.available}
        aria-describedby="voice-settings-explanation"
        className={SETTINGS_CHECKBOX}
        onChange={event => {
          setError(null);
          try { preference.setEnabled(event.target.checked); } catch {
            setError({ key: preference.key, message: 'Could not save this preference. Voice is off for this session. Try disabling it again before reloading.' });
          }
        }}
      />
      <div className="min-w-0">
        <label className={`${SETTINGS_LABEL} cursor-pointer`} htmlFor="voice-briefings-enabled">
          Enable voice briefings
        </label>
        <p id="voice-settings-explanation" className="mt-1 text-[12px] leading-5 text-slate-500">
          Spoken summaries on request. Saved for this browser only. The microphone is used only after you choose Listen.
        </p>
        {!preference.available && (
          <p className="mt-2 text-[12px] leading-5 text-slate-500">
            Sign in to this instance to choose this preference.
          </p>
        )}
        {error && error.key === preference.key && (
          <p role="alert" className="mt-2 text-[12px] leading-5 text-red-600">{error.message}</p>
        )}
      </div>
    </div>
  );
}

export default function VoiceSettingsSection() {
  return (
    <SettingsSection title="Voice briefings">
      <VoiceBriefingsToggle />
    </SettingsSection>
  );
}
