import { useEffect, useState } from 'react';
import type { ExtensionLibraryRevision } from '@propr/shared';
import { listPlugins } from '../../../api/pluginsApi';

/**
 * The display names of the plugins that manage library items, read once the library has managed items. Until the plugin
 * list answers (or when it cannot be read) the plugin id is shown instead.
 */
export function usePluginNames(library: ExtensionLibraryRevision | undefined): Record<string, string> {
  const ids = [...new Set([...(library?.servers ?? []), ...(library?.skills ?? [])].flatMap(item => (item.managedBy ? [item.managedBy.plugin] : [])))].sort().join(',');
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!ids) return;
    let active = true;
    void listPlugins()
      .then(({ plugins }) => { if (active) setNames(Object.fromEntries(plugins.flatMap(plugin => (plugin.manifest ? [[plugin.id, plugin.manifest.name]] : [])))); })
      .catch(() => {});
    return () => { active = false; };
  }, [ids]);
  return names;
}
