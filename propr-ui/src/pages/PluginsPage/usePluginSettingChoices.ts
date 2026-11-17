import { useCallback, useEffect, useRef, useState } from 'react';
import { getPluginSettingOptions } from '../../api/pluginsApi';

export interface SettingChoice { value: string; label: string }
/** The choices of an `optionsFrom` setting: loading, loaded, or the plugin's refusal (typically: not connected yet). */
export type SettingChoices = { state: 'loading' } | { state: 'loaded'; options: SettingChoice[] } | { state: 'failed'; error: string };

const message = (error: unknown) => (error instanceof Error && error.message ? error.message : 'The choices could not be loaded.');

/**
 * Load the choices of a setting whose manifest names `optionsFrom`, from the
 * plugin's settings options route. Null when the setting has none (or there
 * is no plugin to ask). `reload` asks again, for after a connection was set.
 */
export function useSettingChoices(pluginId: string | undefined, setting: string, optionsFrom: string | undefined) {
  const [choices, setChoices] = useState<SettingChoices | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    if (!pluginId || !optionsFrom) { setChoices(null); return; }
    const at = ++sequence.current;
    setChoices({ state: 'loading' });
    try {
      const { options } = await getPluginSettingOptions(pluginId, setting);
      if (at === sequence.current) setChoices({ state: 'loaded', options });
    } catch (error) {
      if (at === sequence.current) setChoices({ state: 'failed', error: message(error) });
    }
  }, [pluginId, setting, optionsFrom]);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);
  return { choices, reload: load };
}
