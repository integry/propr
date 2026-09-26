import { useState } from 'react';
import { isDesktopRuntime } from '../../config/runtimeMode';
import { useVoicePreference } from '../../hooks/useVoicePreference';
import { SettingsSection } from './SettingsLayout';
import { SETTINGS_CHECKBOX, SETTINGS_LABEL } from './settingsStyles';

export default function VoiceSettingsSection() {
  const preference = useVoicePreference();
  const [error, setError] = useState<{ key: string | null; message: string } | null>(null);
  return (
    <SettingsSection title="Voice briefings · Experimental">
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
            Off by default in every runtime. Saved for this account and instance on this device; other
            devices, browsers, and accounts keep their own choice. Enables on-demand briefings and, where
            the runtime supports it, one short spoken command.
            {isDesktopRuntime()
              ? ' Microphone access does not enable speech recognition in this desktop runtime; use text briefings or voice commands in a supported browser.'
              : ' Microphone access is requested only after you acknowledge the vendor-processing notice and select Listen.'}
            {' '}Turning this off stops voice activity and hides its controls. Enabling it does not request
            microphone access or start audio.
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
    </SettingsSection>
  );
}
