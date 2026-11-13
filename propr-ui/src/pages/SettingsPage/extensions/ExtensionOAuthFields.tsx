import { useState } from 'react';
import type { ExtensionLibraryServer, ExtensionOAuthCheckResult } from '@propr/shared';
import { checkExtensionOAuth } from '../../../api/extensionProfilesApi';
import { NO_PUBLIC_URL } from './ExtensionOAuthConnection';
import { buttonClass, inputClass } from './extensionUi';

type Patch = (patch: Partial<ExtensionLibraryServer>) => void;
const REGISTRATION_LABELS = {
  metadata_document: 'Client ID Metadata Document',
  dynamic: 'Dynamic Client Registration',
  preregistered: 'Pre-registered client',
} as const;
const parseScopes = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

/** What Check found: the authorization server, scopes and registration method, or why sign-in is not possible. */
function OAuthCheckResult({ result }: { result: ExtensionOAuthCheckResult }) {
  return (
    <div role="status" data-testid="extension-oauth-check" className="space-y-1 rounded-md bg-white p-2 text-xs text-slate-700">
      {result.authorizationRequired && (
        <>
          <p>Authorization server: <span className="break-all">{result.issuer}</span> (found through {result.discoveredFrom === 'challenge' ? 'the server’s 401 challenge' : 'its well-known metadata'})</p>
          {result.scopes && result.scopes.length > 0 && <p>Scopes requested: {result.scopes.join(', ')}</p>}
          <p>Registration: {result.registration ? REGISTRATION_LABELS[result.registration] : 'none available'}</p>
        </>
      )}
      <p className={result.authorizationRequired && !result.registration ? 'text-amber-800' : ''}>{result.message}</p>
    </div>
  );
}

/** The write-only secret of a pre-registered client. */
function ClientSecretField({ configured, secret, dropped, onSecret }: { configured: boolean; secret: string; dropped: boolean; onSecret: (secret: string) => void }) {
  const kept = configured && !dropped;
  return (
    <label className="block">
      Client secret{' '}
      <span className="text-xs text-slate-500">({kept ? 'configured' : 'not configured'}; write-only, optional)</span>
      <input type="password" autoComplete="new-password" className={inputClass} value={secret}
        placeholder={kept ? 'Leave blank to keep the configured secret' : 'Only if the provider issued one'}
        onChange={event => onSecret(event.target.value)} />
      {configured && dropped && !secret && <span className="mt-1 block text-xs text-amber-800">Changing the name, endpoint or client id clears the stored secret. Enter it again.</span>}
    </label>
  );
}

/**
 * OAuth settings of an HTTPS server: requested scopes, an optional
 * pre-registered client (id and write-only secret), the redirect URI to
 * register with a provider, and Check, which runs discovery without storing anything.
 */
export function ServerOAuthFields({ server, redirectUri, secretConfigured, secret, secretDropped, onChange, onSecret }: {
  server: Extract<ExtensionLibraryServer, { kind: 'https' }>;
  redirectUri: string | null;
  /** A client secret is stored for the saved server. */
  secretConfigured: boolean;
  secret: string;
  /** The name, endpoint or client id changed, so the stored client secret will not carry over. */
  secretDropped: boolean;
  onChange: Patch;
  onSecret: (secret: string) => void;
}) {
  const [scopeText, setScopeText] = useState(() => server.scopes?.join(' ') ?? '');
  const [check, setCheck] = useState<{ status: 'idle' | 'running' | 'done' | 'failed'; result?: ExtensionOAuthCheckResult; error?: string }>({ status: 'idle' });
  const runCheck = () => {
    setCheck({ status: 'running' });
    void checkExtensionOAuth(server.url, { clientId: server.clientId, scopes: server.scopes })
      .then(({ check: result }) => setCheck({ status: 'done', result }))
      .catch(e => setCheck({ status: 'failed', error: (e as Error).message }));
  };
  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="extension-oauth-fields">
      <p role="note" className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
        Every run this server applies to acts with the access of the account that signs in. Sign in with a dedicated service account
        and request the narrowest scopes the tools need.
      </p>
      <label className="block">
        Scopes <span className="text-xs text-slate-500">(optional, separated by spaces; empty uses what the server asks for)</span>
        <input className={inputClass} value={scopeText} placeholder="docs.read" onChange={event => {
          setScopeText(event.target.value);
          const scopes = parseScopes(event.target.value);
          onChange({ scopes: scopes.length ? scopes : undefined });
        }} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          Client id <span className="text-xs text-slate-500">(only for a client registered in the provider’s developer console)</span>
          <input className={inputClass} value={server.clientId ?? ''} autoComplete="off" onChange={event => {
            const clientId = event.target.value.trim();
            onChange({ clientId: clientId || undefined });
            if (!clientId) onSecret('');
          }} />
        </label>
        {server.clientId !== undefined && <ClientSecretField configured={secretConfigured} secret={secret} dropped={secretDropped} onSecret={onSecret} />}
      </div>
      <div className="space-y-1 text-xs text-slate-600">
        <p>Redirect URI to register with the provider:</p>
        {redirectUri ? <code data-testid="extension-oauth-redirect-uri" className="block break-all rounded bg-white px-2 py-1 text-slate-900">{redirectUri}</code> : <p className="text-amber-800">{NO_PUBLIC_URL}</p>}
        <p>Save the server, then use <strong>Connect</strong> in its row to sign in. Changing the URL, the authentication or the client id requires a new sign-in.</p>
      </div>
      <div className="space-y-2">
        <button type="button" className={buttonClass} disabled={!server.url || check.status === 'running'} onClick={runCheck}>
          {check.status === 'running' ? 'Checking…' : 'Check'}
        </button>
        <span className="ml-2 text-xs text-slate-500">Runs OAuth discovery on this endpoint. Nothing is stored.</span>
        {check.status === 'failed' && <p role="alert" className="text-xs text-red-800">Check failed: {check.error}</p>}
        {check.result && <OAuthCheckResult result={check.result} />}
      </div>
    </div>
  );
}
