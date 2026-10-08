import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { updateSettings } from '../../api/proprApi';
import type { Settings, UnattendedSettingName, UnattendedSettingValues } from './types';

interface SaveLifecycle {
  beginSave: () => boolean;
  completeSave: (warnings?: string[]) => void;
  failSave: (err: unknown, fallbackMessage: string) => void;
  reconcileSaveFailure: (err: unknown) => Promise<unknown>;
  setSettings: Dispatch<SetStateAction<Settings>>;
}

/**
 * Saves one unattended agent run limit on its own rather than with the other
 * settings, so a stored window that no longer parses never makes every other
 * save fail. Saving a window clears the server's malformed-window warning.
 */
export function useUnattendedSettingSave({ beginSave, completeSave, failSave, reconcileSaveFailure, setSettings }: SaveLifecycle) {
  return useCallback(async <K extends UnattendedSettingName>(name: K, value: UnattendedSettingValues[K]) => {
    if (!beginSave()) return;
    try {
      const result = await updateSettings({ [name]: name === 'unattended_window' ? (String(value).trim() || null) : value });
      setSettings(previous => ({
        ...previous,
        [name]: value,
        ...(name === 'unattended_window' ? { unattended_window_error: undefined } : {}),
      }));
      completeSave(result.warnings);
    } catch (err) {
      failSave(await reconcileSaveFailure(err), 'Failed to save unattended agent run settings');
    }
  }, [beginSave, completeSave, failSave, reconcileSaveFailure, setSettings]);
}
