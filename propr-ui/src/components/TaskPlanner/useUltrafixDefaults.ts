import { useEffect, useState } from 'react';
import type { InstanceCatalogResponse } from '@propr/shared';
import { getInstanceCatalog } from '../../api/proprApi';

export type UltrafixDefaults = NonNullable<InstanceCatalogResponse['ultrafixDefaults']>;

/**
 * The instance ultrafix target score and loop limit that apply when a plan sets none.
 * Undefined while the catalog loads, and when the server does not report them.
 */
export function useUltrafixDefaults(enabled = true): UltrafixDefaults | undefined {
  const [defaults, setDefaults] = useState<UltrafixDefaults>();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getInstanceCatalog()
      .then(catalog => { if (!cancelled) setDefaults(catalog.ultrafixDefaults); })
      .catch(err => console.error('Failed to load the ultrafix defaults:', err));
    return () => { cancelled = true; };
  }, [enabled]);
  return defaults;
}
