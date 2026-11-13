import { useEffect, useState } from 'react';
import type { ExtensionCatalogEntry, ExtensionLibraryServer, ExtensionSecretStatus } from '@propr/shared';
import { discoverExtensionTools } from '../../../api/extensionProfilesApi';
import { ExtensionItemPicker } from './ExtensionItemPicker';
import { buttonClass, inputClass } from './extensionUi';

type Patch = (patch: Partial<ExtensionLibraryServer>) => void;

/** HTTPS endpoint of a server, with the saved endpoints offered for reuse. */
export function ServerEndpointField({ server, endpoints, onChange }: { server: ExtensionLibraryServer; endpoints: string[]; onChange: Patch }) {
  if (server.kind !== 'https') return null;
  return (
    <div className="space-y-2 text-sm">
      {endpoints.length > 0 && (
        <label className="block">
          Use a saved HTTPS endpoint
          <select className={inputClass} value="" onChange={event => { if (event.target.value) onChange({ url: event.target.value }); }}>
            <option value="">Select an endpoint</option>
            {endpoints.map(url => <option key={url} value={url}>{url}</option>)}
          </select>
        </label>
      )}
      <label className="block">
        HTTPS endpoint
        <input className={inputClass} value={server.url} placeholder="https://tools.example.com/mcp" onChange={event => onChange({ url: event.target.value })} />
      </label>
    </div>
  );
}

/** Identity and credential status of an operator catalog server. */
export function CatalogServerDetails({ server, catalog, secrets }: { server: ExtensionLibraryServer; catalog: ExtensionCatalogEntry[]; secrets?: Record<string, ExtensionSecretStatus> }) {
  if (server.kind !== 'catalog') return null;
  const configured = (secrets?.[server.name] ?? catalog.find(entry => entry.id === server.catalogId)?.secrets)?.configured;
  return (
    <div className="break-all text-xs text-slate-600">
      <p>Operator catalog entry: {server.catalogId}</p>
      <p>SHA-256 {server.digest}</p>
      <p>Operator secrets: {configured ? 'configured' : 'not configured'}</p>
    </div>
  );
}

const DISCOVERING = 'Discovering tools…';

/** Allowed tools: the catalog entry's tools, or tools discovered on (or saved for) an HTTPS endpoint. */
export function ServerToolsField({ server, catalog, knownTools, onChange }: { server: ExtensionLibraryServer; catalog: ExtensionCatalogEntry[]; knownTools: string[]; onChange: Patch }) {
  const url = server.kind === 'https' ? server.url : '';
  const [probe, setProbe] = useState<{ url: string; attempt: number }>();
  const [discovered, setDiscovered] = useState<{ url: string; tools: string[] }>();
  const [status, setStatus] = useState('');
  useEffect(() => {
    setStatus('');
    if (!probe || probe.url !== url) return;
    let active = true;
    setStatus(DISCOVERING);
    void discoverExtensionTools(url).then(result => {
      if (!active) return;
      setDiscovered({ url, tools: result.tools });
      setStatus(result.tools.length ? 'Tools discovered. Select the allowed tools below.' : 'No tools discovered.');
    }).catch(() => { if (active) setStatus('Discovery unavailable. This probe uses no credentials; add tools as unlisted values instead.'); });
    return () => { active = false; };
  }, [probe, url]);
  const options = server.kind === 'catalog'
    ? catalog.find(entry => entry.id === server.catalogId && entry.digest === server.digest)?.tools ?? server.tools
    : [...new Set([...knownTools, ...(discovered?.url === url ? discovered.tools : [])])];
  return (
    <div className="space-y-2">
      {server.kind === 'https' && (
        <div className="space-y-2 text-sm">
          <button type="button" className={buttonClass} disabled={!url || status === DISCOVERING}
            onClick={() => setProbe({ url, attempt: (probe?.attempt ?? 0) + 1 })}>Discover tools</button>
          <p className="text-xs text-slate-500">Probe this endpoint without credentials to find selectable tools.</p>
          {status && <p role="status">{status}</p>}
        </div>
      )}
      <ExtensionItemPicker label="Allowed tools" options={options} selected={server.tools} onChange={tools => onChange({ tools })}
        allowManual={server.kind === 'https'} manualLabel="Unlisted tool name"
        hint={server.kind === 'https' ? 'Discover tools or choose from saved servers on this endpoint.' : undefined} />
    </div>
  );
}

/** Capability, authentication and the write-only Bearer token. */
export function ServerAccessFields({ server, configured, token, tokenDropped, onChange, onToken }: {
  server: ExtensionLibraryServer;
  /** A token is stored for the saved server. */
  configured: boolean;
  token: string;
  /** The name or endpoint changed, so the stored token will not carry over. */
  tokenDropped: boolean;
  onChange: Patch;
  onToken: (token: string) => void;
}) {
  const bearer = server.kind === 'https' && server.authentication === 'bearer';
  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm">
          Capability
          <select className={inputClass} value={server.capability} disabled={server.kind === 'catalog'}
            onChange={event => onChange({ capability: event.target.value as 'read' | 'write' })}>
            <option value="read">Read</option>
            <option value="write">Write — needs the write opt-in</option>
          </select>
        </label>
        {server.kind === 'https' && (
          <label className="text-sm">
            Authentication
            <select className={inputClass} value={server.authentication} onChange={event => onChange({ authentication: event.target.value as 'none' | 'bearer' })}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
            </select>
          </label>
        )}
      </div>
      {bearer && (
        <label className="block text-sm">
          Bearer token{' '}
          <span className="text-xs text-slate-500">({configured && !tokenDropped ? 'configured' : 'not configured'}; write-only)</span>
          <input type="password" autoComplete="new-password" className={inputClass} value={token}
            placeholder={configured && !tokenDropped ? 'Leave blank to keep the configured token' : 'Enter the token'}
            onChange={event => onToken(event.target.value)} />
          {configured && tokenDropped && !token && <span className="mt-1 block text-xs text-amber-800">Changing the name or endpoint clears the stored token. Enter it again.</span>}
        </label>
      )}
    </>
  );
}
