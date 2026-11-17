import { useEffect, useState } from 'react';
import { AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING, DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD } from '@propr/shared';
import { getSettings } from '../../api/configApi';
import { useCurrentUser, userHasPermission } from '../../contexts/AuthContext';

/**
 * How many runs in a row with nothing new make the Inbox notice (and the
 * optional pause), from the instance setting; null while it is not known.
 * Only people who manage settings can read it, so for everyone else (and when
 * the read fails) it stays null: the instance may have set a number other
 * than the default, and the form must not promise one it cannot see. A read
 * without a usable value means the server applies the default too.
 */
export function useUnproductiveRunThreshold(): number | null {
  const canRead = userHasPermission(useCurrentUser(), 'instance.manage_settings');
  const [threshold, setThreshold] = useState<number | null>(null);
  useEffect(() => {
    setThreshold(null);
    if (!canRead) return;
    let active = true;
    getSettings()
      .then(settings => {
        if (!active) return;
        const value = (settings as unknown as Record<string, unknown>)[AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING];
        setThreshold(Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [canRead]);
  return threshold;
}
