import { useState } from 'react';
import type { PluginConnectionView, PluginView } from '../../api/pluginsApi';
import { ExtensionOAuthConnection } from '../SettingsPage/extensions/ExtensionOAuthConnection';
import { ExternalLink, PluginStep } from './PluginBits';
import { dangerButtonClass, formatWhen, inputClass, primaryButtonClass, safeHttpsUrl } from './pluginUi';

export interface PluginConnectionActions {
  /** Null when the instance has no public base URL: OAuth Connect is unavailable. */
  redirectUri: string | null;
  busy: boolean;
  oauthBusy: (name: string) => boolean;
  onConnect: (name: string) => void;
  onDisconnect: (name: string) => void;
  /** Store (`value`) or clear (`null`) a write-only secret; resolves true once saved. */
  onSetSecret: (name: string, value: string | null) => Promise<boolean>;
}

const TYPE_LABELS = { oauth: 'OAuth sign-in', token: 'API token', signing_secret: 'Signing secret' } as const;

/** A write-only secret: the field never shows a stored value, only whether one is set and by whom. */
function SecretField({ connection, actions, locked }: { connection: PluginConnectionView; actions: PluginConnectionActions; locked: boolean }) {
  const [value, setValue] = useState('');
  const set = connection.state === 'connected';
  const fieldId = `plugin-secret-${connection.name}`;
  const save = () => void actions.onSetSecret(connection.name, value.trim()).then(ok => { if (ok) setValue(''); });
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-600">
        {set ? `Stored${connection.setBy ? ` by administrator ${connection.setBy}` : ''}${connection.setAt !== undefined ? ` · ${formatWhen(connection.setAt)}` : ''}. ProPR never shows it again.` : 'Not set.'}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label htmlFor={fieldId} className="min-w-0 flex-1 text-sm font-medium">{set ? `Replace ${connection.label}` : connection.label}
          <input id={fieldId} type="password" autoComplete="off" spellCheck={false} className={inputClass} value={value}
            onChange={event => setValue(event.target.value)} />
        </label>
        <button type="button" className={primaryButtonClass} disabled={actions.busy || !value.trim()} onClick={save}>{set ? 'Replace' : 'Save'}</button>
        {set && (
          <button type="button" className={dangerButtonClass} disabled={actions.busy || locked} onClick={() => void actions.onSetSecret(connection.name, null)}>Clear</button>
        )}
      </div>
      {set && locked && <p className="text-xs text-slate-600">Disable the plugin before clearing this required connection.</p>}
    </div>
  );
}

function ConnectionRow({ connection, help, helpUrl, actions, locked }: {
  connection: PluginConnectionView; help?: string; helpUrl: string | null; actions: PluginConnectionActions; locked: boolean;
}) {
  return (
    <li data-testid="plugin-connection" data-state={connection.state} className="space-y-2 rounded-md border border-slate-200 p-3">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">{connection.label}</span>
        <span className="text-xs text-slate-500">{TYPE_LABELS[connection.type]}{connection.required ? ' · required to enable' : ''}</span>
      </p>
      {help && <p className="text-slate-600 [overflow-wrap:anywhere]">{help}</p>}
      {helpUrl && <p className="text-xs"><ExternalLink href={helpUrl}>How to get it</ExternalLink></p>}
      {connection.type === 'oauth' ? (
        <ExtensionOAuthConnection name={connection.label} status={{ state: connection.state }} redirectUri={actions.redirectUri}
          busy={actions.oauthBusy(connection.name)} onConnect={() => actions.onConnect(connection.name)} onDisconnect={() => actions.onDisconnect(connection.name)} />
      ) : <SecretField connection={connection} actions={actions} locked={locked} />}
    </li>
  );
}

/** Connect: one row per connection with its state and the action its type needs. */
export function PluginConnections({ view, actions }: { view: PluginView; actions: PluginConnectionActions }) {
  const installed = Boolean(view.installation);
  const declared = view.manifest?.connections ?? [];
  const done = installed && view.connections.every(c => c.state === 'connected');
  return (
    <PluginStep number={2} title="Connect" done={done}>
      {!installed && <p className="text-slate-500">Install the plugin first.</p>}
      {installed && view.connections.length === 0 && <p>This plugin needs no connections.</p>}
      {installed && view.connections.length > 0 && (
        <ul aria-label="Connections" className="space-y-3">
          {view.connections.map(connection => {
            const manifest = declared.find(c => c.name === connection.name);
            return (
              <ConnectionRow key={connection.name} connection={connection} help={manifest?.help} helpUrl={safeHttpsUrl(manifest?.helpUrl)}
                actions={actions} locked={Boolean(view.installation?.enabled && connection.required)} />
            );
          })}
        </ul>
      )}
      {installed && view.connections.some(c => c.type === 'oauth' && c.state !== 'connected') && (
        <p className="text-xs text-slate-600">Sign-in opens in a new tab. This page refreshes when you come back.</p>
      )}
    </PluginStep>
  );
}
