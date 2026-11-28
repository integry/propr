import { useCallback, useEffect, useRef, useState } from 'react';
import { getPluginWebhooks, regeneratePluginWebhookKey, type PluginWebhooksView } from '../../api/pluginsApi';

const message = (error: unknown) => (error instanceof Error ? error.message : 'Webhook URLs unavailable.');

/** The installed plugin's webhook URLs, with Regenerate; read while it is installed. */
export function usePluginWebhooks(id: string, installed: boolean) {
  const [webhooks, setWebhooks] = useState<PluginWebhooksView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const at = ++sequence.current;
    try {
      const result = await getPluginWebhooks(id);
      if (at === sequence.current) { setWebhooks(result); setError(''); }
    } catch (failure) { if (at === sequence.current) setError(message(failure)); }
  }, [id]);
  useEffect(() => {
    setWebhooks(null); setError('');
    if (installed) void load(); else sequence.current += 1;
  }, [installed, load]);
  const regenerate = useCallback(async () => {
    setBusy(true); setError('');
    const at = ++sequence.current;
    try {
      const result = await regeneratePluginWebhookKey(id);
      if (at === sequence.current) setWebhooks(result);
      return true;
    } catch (failure) { setError(message(failure)); return false; } finally { setBusy(false); }
  }, [id]);
  return { webhooks, error, busy, regenerate };
}
