import { useCallback, useEffect, useRef, useState } from 'react';
import { getPluginActivity, resumePluginDeliveries, retryPluginDelivery, type PluginActivityView } from '../../api/pluginsApi';

const message = (error: unknown) => (error instanceof Error ? error.message : 'Plugin activity unavailable.');

/** The installation's delivery health and records, with Retry and Resume; read only while the plugin is installed. */
export function usePluginActivity(id: string, installed: boolean) {
  const [activity, setActivity] = useState<PluginActivityView | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** `resume`, or the record id being retried. */
  const [busy, setBusy] = useState<'resume' | number | null>(null);
  // A read applies only while it is still the latest one for this plugin.
  const sequence = useRef(0);

  /** Read again; `keepError` keeps an action's refusal on screen. */
  const reload = useCallback(async (keepError = false) => {
    const at = ++sequence.current;
    try {
      const result = await getPluginActivity(id);
      if (at === sequence.current) { setActivity(result); if (!keepError) setError(''); }
    } catch (failure) { if (at === sequence.current) setError(message(failure)); }
  }, [id]);
  useEffect(() => {
    setActivity(null); setError(''); setNotice('');
    if (installed) void reload();
    else sequence.current += 1;
  }, [installed, reload]);

  const act = useCallback(async (key: 'resume' | number, work: () => Promise<unknown>, done: string) => {
    setBusy(key); setError(''); setNotice('');
    try { await work(); setNotice(done); } catch (failure) { setError(message(failure)); } finally {
      setBusy(null);
      await reload(true);
    }
  }, [reload]);

  return {
    activity, error, notice, busy,
    /** Read again on request; an earlier action's notice no longer applies. */
    refresh: () => { setNotice(''); return reload(); },
    retry: (recordId: number) => act(recordId, () => retryPluginDelivery(id, recordId), 'Retry scheduled. The delivery runs again shortly with the same delivery id.'),
    resume: () => act('resume', () => resumePluginDeliveries(id), 'Deliveries resumed.'),
  };
}
