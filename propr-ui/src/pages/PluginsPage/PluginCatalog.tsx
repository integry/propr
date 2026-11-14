import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PLUGIN_CATEGORIES } from '@propr/shared';
import type { PluginView } from '../../api/pluginsApi';
import { PluginIcon, PluginStateBadge } from './PluginBits';
import { CATEGORY_LABELS, inputClass, pluginPath } from './pluginUi';

function PluginCard({ view }: { view: PluginView }) {
  const manifest = view.manifest;
  const name = manifest?.name ?? view.id;
  return (
    <li data-testid="plugin-card">
      <Link to={pluginPath(view.id)} aria-label={`${name}: open`}
        className="flex h-full gap-3 rounded-lg border border-slate-200 bg-white p-4 hover:border-teal-600 hover:bg-teal-50/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600">
        <PluginIcon category={manifest?.category} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-900">{name}</span>
            <PluginStateBadge view={view} />
          </span>
          <span className="block text-sm text-slate-600 [overflow-wrap:anywhere]">
            {manifest?.description ?? 'No longer in this ProPR version. It can only be disabled or uninstalled.'}
          </span>
          {manifest && <span className="block text-xs text-slate-500">{CATEGORY_LABELS[manifest.category]}</span>}
        </span>
      </Link>
    </li>
  );
}

/** Every available or installed plugin as cards, filtered by category and searched by name. */
export function PluginCatalog({ plugins }: { plugins: PluginView[] }) {
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const query = search.trim().toLowerCase();
    return plugins.filter(view => (!category || view.manifest?.category === category)
      && (!query || (view.manifest?.name ?? view.id).toLowerCase().includes(query) || view.id.includes(query)));
  }, [plugins, category, search]);
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-sm font-medium text-slate-700">Search by name
          <input type="search" className={inputClass} value={search} onChange={event => setSearch(event.target.value)} />
        </label>
        <label className="text-sm font-medium text-slate-700 sm:w-56">Category
          <select className={inputClass} value={category} onChange={event => setCategory(event.target.value)}>
            <option value="">All categories</option>
            {PLUGIN_CATEGORIES.map(value => <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>)}
          </select>
        </label>
      </div>
      {plugins.length === 0 && <p className="text-sm text-slate-500">No plugins are available in this ProPR version.</p>}
      {plugins.length > 0 && shown.length === 0 && <p role="status" className="text-sm text-slate-500">No plugin matches this search.</p>}
      <ul aria-label="Plugins" className="grid gap-3 sm:grid-cols-2">
        {shown.map(view => <PluginCard key={view.id} view={view} />)}
      </ul>
    </div>
  );
}
