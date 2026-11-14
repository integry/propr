import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PluginConfigureStep } from './PluginConfigureStep';
import { PluginConnections } from './PluginConnections';
import { PluginContributions } from './PluginContributions';
import { PluginEnableStep } from './PluginEnableStep';
import { PluginInstallStep } from './PluginInstallStep';
import { PluginUninstall } from './PluginUninstall';
import { ExternalLink, PluginIcon, PluginStateBadge } from './PluginBits';
import { CATEGORY_LABELS, PLUGINS_PATH, safeHttpsUrl } from './pluginUi';
import { usePluginDetail } from './usePluginDetail';

const back = (
  <Link to={PLUGINS_PATH} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-teal-700 hover:text-teal-800 sm:min-h-0">
    <ArrowLeft aria-hidden="true" className="h-4 w-4" /> All plugins
  </Link>
);

/** One plugin: its header, the four steps in a fixed order, what it added and uninstall. */
export function PluginDetail({ id }: { id: string }) {
  const detail = usePluginDetail(id);
  const { view } = detail;
  if (!view) {
    return (
      <div className="space-y-4">
        {back}
        {detail.loadError ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{detail.loadError}</p> : <p className="text-sm text-slate-500">Loading the plugin…</p>}
      </div>
    );
  }
  const { manifest } = view;
  const homepage = safeHttpsUrl(manifest?.homepage);
  return (
    <div className="space-y-4">
      {back}
      <header className="flex gap-3">
        <PluginIcon category={manifest?.category} />
        <div className="min-w-0 space-y-1">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-slate-900">
            <span className="[overflow-wrap:anywhere]">{manifest?.name ?? view.id}</span>
            <PluginStateBadge view={view} />
          </h1>
          {manifest && <p className="text-sm text-slate-600 [overflow-wrap:anywhere]">{manifest.description}</p>}
          <p className="flex flex-wrap gap-x-3 text-xs text-slate-500">
            {manifest && <span>{CATEGORY_LABELS[manifest.category]}</span>}
            {manifest && <span>Version {manifest.version}</span>}
            {homepage && <ExternalLink href={homepage}>Homepage</ExternalLink>}
          </p>
          {!view.available && <p className="text-sm text-amber-800">This plugin is no longer in this ProPR version. It can only be disabled or uninstalled.</p>}
        </div>
      </header>
      {detail.errors.general && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800 [overflow-wrap:anywhere]">{detail.errors.general}</p>}
      {detail.notice && <p role="status" className="text-sm text-teal-800">{detail.notice}</p>}
      <PluginInstallStep view={view} busy={detail.busy} onInstall={acks => void detail.install(acks)} onApprove={acks => void detail.approve(acks)} />
      <PluginConnections view={view} actions={{
        redirectUri: detail.redirectUri, busy: detail.busy, oauthBusy: detail.oauthBusy,
        onConnect: name => void detail.connectOAuth(name), onDisconnect: name => void detail.disconnectOAuth(name), onSetSecret: detail.setSecret,
      }} />
      <PluginConfigureStep key={(view.installation?.repositories ?? []).join(',')} view={view} busy={detail.busy} onSave={detail.setRepositories} />
      <PluginEnableStep view={view} busy={detail.busy} onChange={detail.setEnabled} />
      <PluginContributions view={view} />
      <PluginUninstall view={view} busy={detail.busy} error={detail.errors.uninstall} onUninstall={() => void detail.uninstall()} />
    </div>
  );
}
