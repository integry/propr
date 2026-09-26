import React from 'react';
import { Loader2 } from 'lucide-react';
import { SettingsStatus, type SettingsStatusTone } from './SettingsLayout';

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
  if (saveStatus === 'saved') return { tone: 'ok', message: 'Settings auto-saved' };
  return { tone: 'pending', message: 'All changes saved' };
}

/**
 * The anchored save indicator. Success is quiet here too: a teal dot beside
 * neutral text, aligned to the same container the settings form uses.
 */
const SettingsSaveStatusBar: React.FC<SettingsSaveStatusBarProps> = ({ saveStatus, globalError }) => {
  const { tone, message } = resolve(saveStatus, globalError);
  return (
    <div className="flex-shrink-0 border-t border-slate-200 bg-white px-4 py-3">
      <div className="mx-auto flex max-w-4xl items-center justify-between">
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
