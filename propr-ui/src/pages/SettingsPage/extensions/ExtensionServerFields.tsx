import { useEffect, useId, useState } from 'react';
import type { ExtensionCatalogEntry, ExtensionLibraryServer, ExtensionSecretStatus } from '@propr/shared';
import { discoverExtensionTools } from '../../../api/extensionProfilesApi';
import { ExtensionItemPicker } from './ExtensionItemPicker';
import { ServerOAuthFields } from './ExtensionOAuthFields';
import { SERVER_NAME_MAX } from './extensionValidation';
import { buttonClass, fieldErrorClass, hintClass, inputClass, labelClass, ownEntry } from './extensionUi';

type Patch = (patch: Partial<ExtensionLibraryServer>) => void;

/** HTTPS endpoint of a server, with the saved endpoints offered for reuse; `problem` is shown once the field was left. */
export function ServerEndpointField({ server, endpoints, problem, onBlur, onChange }: {
  server: ExtensionLibraryServer; endpoints: string[]; problem?: string; onBlur?: () => void; onChange: Patch;
}) {
  const inputId = useId();
  const errorId = useId();
  if (server.kind !== 'https') return null;
  return (
    <div className="space-y-2">
      {endpoints.length > 0 && (
        <label className={labelClass}>
          Use a saved HTTPS endpoint
          <select className={inputClass} value="" onChange={event => { if (event.target.value) onChange({ url: event.target.value }); }}>
            <option value="">Select an endpoint</option>
            {endpoints.map(url => <option key={url} value={url}>{url}</option>)}
          </select>
        </label>
      )}
      <div>
        <label htmlFor={inputId} className={labelClass}>HTTPS endpoint</label>
        <input id={inputId} className={inputClass} value={server.url} placeholder="https://tools.example.com/mcp" type="url" inputMode="url" autoCapitalize="none" spellCheck={false}
          aria-invalid={Boolean(problem)} aria-describedby={problem ? errorId : undefined}
          onChange={event => onChange({ url: event.target.value.trim() })} onBlur={onBlur} />
        {problem && <span id={errorId} role="alert" className={fieldErrorClass}>{problem}</span>}
      </div>
    </div>
  );
}

/** The server name with its rule, and the rule's problem once the field was left. */
export function ServerNameField({ name, problem, onBlur, onChange }: { name: string; problem?: string; onBlur: () => void; onChange: (name: string) => void }) {
  const inputId = useId();
  const hintId = useId();
  return (
    <div>
      <label htmlFor={inputId} className={labelClass}>Server name</label>
      <input id={inputId} className={inputClass} value={name} autoCapitalize="none" autoComplete="off" spellCheck={false}
        aria-invalid={Boolean(problem)} aria-describedby={hintId}
        onChange={event => onChange(event.target.value)} onBlur={onBlur} />
      {problem
        ? <span id={hintId} role="alert" className={fieldErrorClass}>{problem}</span>
        : <span id={hintId} className={hintClass}>Up to {SERVER_NAME_MAX} lowercase letters, digits, - and _, starting with a letter.</span>}
    </div>
  );
}

/** Identity and credential status of an operator catalog server. */
export function CatalogServerDetails({ server, catalog, secrets }: { server: ExtensionLibraryServer; catalog: ExtensionCatalogEntry[]; secrets?: Record<string, ExtensionSecretStatus> }) {
  if (server.kind !== 'catalog') return null;
  const configured = (ownEntry(secrets, server.name) ?? catalog.find(entry => entry.id === server.catalogId)?.secrets)?.configured;
  return (
    <div className="break-all text-[12px] leading-5 text-slate-600">
      <p title={`SHA-256 ${server.digest}`}>Preinstalled: {server.catalogId}</p>
      <p>Credentials: {configured ? 'set by the operator' : 'not set'}</p>
    </div>
  );
}

const DISCOVERING = 'Discovering tools…';
const toolProblem = (value: string) => (/^[A-Za-z0-9_.-]{1,128}$/.test(value) ? null : 'Use letters, digits, ., - and _ only (up to 128).');

/** Allowed tools: the catalog entry's tools, or tools discovered on (or saved for) an HTTPS endpoint. */
export function ServerToolsField({ server, catalog, knownTools, urlValid = true, onChange }: {
  server: ExtensionLibraryServer; catalog: ExtensionCatalogEntry[]; knownTools: string[];
  /** The endpoint passes the form's checks; Discover tools waits for a valid one. */
  urlValid?: boolean;
  onChange: Patch;
}) {
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
      const session = result.session === 'stateful' ? ' Stateful server: ProPR keeps its session for each run.' : result.session === 'stateless' ? ' Stateless server: no session is needed.' : '';
      setStatus((result.tools.length ? 'Tools found. Tick the ones the agent may call.' : 'The server listed no tools.') + session);
    }).catch(() => { if (active) setStatus('Could not list tools. Type the tool names below.'); });
    return () => { active = false; };
  }, [probe, url]);
  const options = server.kind === 'catalog'
    ? catalog.find(entry => entry.id === server.catalogId && entry.digest === server.digest)?.tools ?? server.tools
    : server.kind === 'package' ? server.tools : [...new Set([...knownTools, ...(discovered?.url === url ? discovered.tools : [])])];
  return (
    <div className="space-y-2">
      {server.kind === 'https' && (
        <div className="space-y-1 text-sm">
          <button type="button" className={buttonClass} disabled={!url || !urlValid || status === DISCOVERING}
            onClick={() => setProbe({ url, attempt: (probe?.attempt ?? 0) + 1 })}>Discover tools</button>
          <p className={hintClass}>Lists the server’s tools. No credentials are sent.</p>
          {status && <p role="status" className="text-[12px] leading-5 text-slate-700">{status}</p>}
        </div>
      )}
      <ExtensionItemPicker label="Allowed tools" options={options} selected={server.tools} onChange={tools => onChange({ tools })}
        allowManual={server.kind !== 'catalog'} manualLabel={server.kind === 'package' ? 'Tool name' : 'Other tool'} manualOpen={server.kind === 'package'} validate={toolProblem}
        hint={server.kind === 'catalog' ? undefined : 'Tools the agent may call. All others are blocked.'} />
    </div>
  );
}

/** Capability, authentication, the write-only Bearer token and the OAuth sign-in settings. */
export function ServerAccessFields({ server, configured, token, tokenDropped, redirectUri, urlValid = true, onChange, onToken }: {
  server: ExtensionLibraryServer;
  /** A token (or, for OAuth, a client secret) is stored for the saved server. */
  configured: boolean;
  token: string;
  /** The name, endpoint or client changed, so the stored credential will not carry over. */
  tokenDropped: boolean;
  /** The OAuth redirect URI of this instance; null without a public base URL. */
  redirectUri: string | null;
  /** The endpoint passes the form's checks; Check sign-in waits for a valid one. */
  urlValid?: boolean;
  onChange: Patch;
  onToken: (token: string) => void;
}) {
  const bearer = server.kind === 'https' && server.authentication === 'bearer';
  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <label className={labelClass}>
          Access
          <select className={inputClass} value={server.capability} disabled={server.kind === 'catalog'}
            onChange={event => onChange({ capability: event.target.value as 'read' | 'write' })}>
            <option value="read">Read</option>
            <option value="write">Write (must be allowed per task)</option>
          </select>
        </label>
        {server.kind === 'https' && (
          <label className={labelClass}>
            Authentication
            <select className={inputClass} value={server.authentication} onChange={event => onChange({ authentication: event.target.value as 'none' | 'bearer' | 'oauth' })}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="oauth">OAuth sign-in</option>
            </select>
          </label>
        )}
      </div>
      {bearer && (
        <label className={labelClass}>
          Bearer token{' '}
          <span className="text-[12px] text-slate-500">({configured && !tokenDropped ? 'saved' : 'not set'})</span>
          <input type="password" autoComplete="new-password" className={inputClass} value={token}
            placeholder={configured && !tokenDropped ? 'Leave blank to keep the saved token' : 'Enter the token'}
            onChange={event => onToken(event.target.value)} />
          {configured && tokenDropped && !token && <span className="mt-1 block text-[12px] text-amber-800">Changing the name or endpoint clears the stored token. Enter it again.</span>}
        </label>
      )}
      {server.kind === 'https' && server.authentication === 'oauth' && (
        <ServerOAuthFields server={server} redirectUri={redirectUri} urlValid={urlValid} secretConfigured={configured} secret={token} secretDropped={tokenDropped} onChange={onChange} onSecret={onToken} />
      )}
    </>
  );
}
