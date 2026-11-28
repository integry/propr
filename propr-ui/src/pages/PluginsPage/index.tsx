import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Puzzle } from 'lucide-react';
import { listPlugins, type PluginView } from '../../api/pluginsApi';
import { useCurrentUser } from '../../contexts/AuthContext';
import { PluginCatalog } from './PluginCatalog';
import { PluginDetail } from './PluginDetail';
import { canManagePlugins } from './pluginUi';

function CatalogView() {
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void listPlugins().then(result => { if (active) setPlugins(result.plugins); })
      .catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, []);
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-teal-50 p-2 text-teal-700"><Puzzle aria-hidden="true" className="h-6 w-6" /></div>
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Plugins</h1>
          <p className="mt-1 text-sm text-gray-600">
            Install a plugin, connect its accounts, choose its repositories and enable it. Every plugin goes through the same steps.
          </p>
        </div>
      </div>
      {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {!plugins && !error && <p className="text-sm text-slate-500">Loading plugins…</p>}
      {plugins && <PluginCatalog plugins={plugins} />}
    </div>
  );
}

/** Instance administration → Plugins: the catalog, or one plugin's detail at /plugins/:pluginId. */
export default function PluginsPage() {
  const user = useCurrentUser();
  const { pluginId } = useParams<{ pluginId?: string }>();
  if (!canManagePlugins(user)) {
    return (
      <div className="mx-auto max-w-2xl py-20 text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Administrator access required</h1>
        <p className="mt-3 text-sm text-gray-600">Plugins are managed by instance administrators who may change instance settings.</p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      {pluginId ? <PluginDetail key={pluginId} id={pluginId} /> : <CatalogView />}
    </div>
  );
}
