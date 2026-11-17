import { useEffect, useState } from 'react';
import { AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING, DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD } from '@propr/shared';
import { getSettings } from '../../api/configApi';
import { useCurrentUser, userHasPermission } from '../../contexts/AuthContext';

/**
 * How many runs in a row with nothing new make the Inbox notice (and the
 * optional pause), from the instance setting. Only people who manage settings
 * can read it; everyone else sees the default the server also falls back to.
 */
export function useUnproductiveRunThreshold(): number {
  const canRead = userHasPermission(useCurrentUser(), 'instance.manage_settings');
  const [threshold, setThreshold] = useState(DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD);
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    getSettings()
      .then(settings => {
        const value = (settings as unknown as Record<string, unknown>)[AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING];
        if (active && Number.isSafeInteger(value) && Number(value) > 0) setThreshold(Number(value));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [canRead]);
  return threshold;
}
