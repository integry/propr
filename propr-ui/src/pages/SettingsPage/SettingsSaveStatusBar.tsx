import React from 'react';
import { Loader2 } from 'lucide-react';
import { SettingsStatus, type SettingsStatusTone } from './SettingsLayout';
import { SETTINGS_CONTAINER } from './settingsStyles';

export type SettingsSaveStatus = 'idle' | 'saving' | 'saved' | 'warning' | 'error';

interface SettingsSaveStatusBarProps {
  saveStatus: SettingsSaveStatus;
  globalError: string | null;
}

function resolve(
  saveStatus: SettingsSaveStatus,
  globalError: string | null
): { tone: SettingsStatusTone; message: string } {
  if (saveStatus === 'error' && globalError) return { tone: 'error', message: globalError };
  if (saveStatus === 'warning' && globalError) return { tone: 'warn', message: `Saved with warning: ${globalError}` };
  if (saveStatus === 'saved') return { tone: 'ok', message: 'All changes saved' };
  // Idle cannot vouch for a blur-saved field that is still being edited, so
  // it explains when saving happens instead of claiming it already did.
  return { tone: 'pending', message: 'Changes save automatically' };
}

/**
 * The anchored save indicator. Success is quiet here too: a teal dot beside
 * neutral text, aligned to the same container the settings form uses.
 */
const SettingsSaveStatusBar: React.FC<SettingsSaveStatusBarProps> = ({ saveStatus, globalError }) => {
  const { tone, message } = resolve(saveStatus, globalError);
  return (
    <div className="flex-shrink-0 border-t border-slate-200 bg-white py-3">
      <div className={`${SETTINGS_CONTAINER} flex items-center justify-between`}>
        {saveStatus === 'saving' ? (
          <span className="flex items-center gap-2 font-mono text-[12px] text-slate-500">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin text-slate-400" />
            Saving changes...
          </span>
        ) : (
          <SettingsStatus tone={tone} role="status" className="font-mono">
            {message}
          </SettingsStatus>
        )}
      </div>
    </div>
  );
};

export default SettingsSaveStatusBar;
