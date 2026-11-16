import { useCallback, useEffect, useRef, useState } from 'react';
import { getPluginSettingOptions, PluginApiError, type PluginSettingOptionView } from '../../api/pluginsApi';

/**
 * Choices of a select setting whose manifest names an `optionsFrom` handler (Linear's teams, say). They are read from
 * the service by the plugin, through the settings-options route, when the field is shown; the administrator can load
 * them again after setting a connection. A refusal, such as a connection that is not made yet, is shown next to the
 * field as the API wrote it.
 */
export interface SettingOptions {
  status: 'loading' | 'loaded' | 'error';
  options: PluginSettingOptionView[];
  error: string;
  reload: () => void;
}

export function useSettingOptions(pluginId: string, setting: string): SettingOptions {
  const [state, setState] = useState<Omit<SettingOptions, 'reload'>>({ status: 'loading', options: [], error: '' });
  const request = useRef(0);
  const reload = useCallback(() => {
    const current = (request.current += 1);
    setState(previous => ({ ...previous, status: 'loading', error: '' }));
    getPluginSettingOptions(pluginId, setting).then(
      result => { if (current === request.current) setState({ status: 'loaded', options: result.options, error: '' }); },
      (error: unknown) => {
        if (current !== request.current) return;
        const message = error instanceof PluginApiError ? error.message : 'The choices could not be loaded. Try again.';
        setState({ status: 'error', options: [], error: message });
      },
    );
  }, [pluginId, setting]);
  useEffect(() => {
    reload();
    // A later answer of an unmounted field is dropped.
    return () => { request.current += 1; };
  }, [reload]);
  return { ...state, reload };
}
