import { useState } from 'react';
import type { ExtensionLibraryServer, ExtensionOAuthCheckResult } from '@propr/shared';
import { checkExtensionOAuth } from '../../../api/extensionProfilesApi';
import { NO_PUBLIC_URL } from './ExtensionOAuthConnection';
import { buttonClass, hintClass, inputClass, labelClass } from './extensionUi';

type Patch = (patch: Partial<ExtensionLibraryServer>) => void;
/** How ProPR gets an OAuth client: on its own (metadata document or dynamic registration), or from the client id entered here. */
const REGISTRATION_LABELS = {
  metadata_document: 'automatic',
  dynamic: 'automatic',
  preregistered: 'uses the client id above',
} as const;
const parseScopes = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

/** What Check sign-in found: the sign-in server, scopes and how the client is set up, or why sign-in is not possible. */
function OAuthCheckResult({ result }: { result: ExtensionOAuthCheckResult }) {
  return (
    <div role="status" data-testid="extension-oauth-check" className="space-y-1 rounded-md bg-white p-2 text-[12px] leading-5 text-slate-700">
      {result.authorizationRequired && (
        <>
          <p>Sign-in server: <span className="break-all">{result.issuer}</span></p>
          {result.scopes && result.scopes.length > 0 && <p>Scopes requested: {result.scopes.join(', ')}</p>}
          <p>Client setup: {result.registration ? REGISTRATION_LABELS[result.registration] : 'needs a client id'}</p>
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
    <label className={labelClass}>
      Client secret{' '}
      <span className="text-[12px] text-slate-500">({kept ? 'saved' : 'not set'})</span>
      <input type="password" autoComplete="new-password" className={inputClass} value={secret}
        placeholder={kept ? 'Leave blank to keep the saved secret' : 'Optional; only if the provider issued one'}
        onChange={event => onSecret(event.target.value)} />
      {configured && dropped && !secret && <span className="mt-1 block text-[12px] text-amber-800">Changing the name, endpoint or client id clears the stored secret. Enter it again.</span>}
    </label>
  );
}

/**
 * OAuth settings of an HTTPS server: requested scopes, an optional
 * pre-registered client (id and write-only secret), the redirect URI to
 * register with a provider, and Check, which runs discovery without storing anything.
 */
export function ServerOAuthFields({ server, redirectUri, urlValid = true, secretConfigured, secret, secretDropped, onChange, onSecret }: {
  server: Extract<ExtensionLibraryServer, { kind: 'https' }>;
  redirectUri: string | null;
  /** The endpoint passes the form's checks; Check sign-in waits for a valid one. */
  urlValid?: boolean;
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
      <p role="note" className="rounded-md bg-amber-50 p-2 text-[12px] leading-5 text-amber-900">
        Every run this server applies to acts with the access of the account that signs in. Sign in with a dedicated service account
        and request the narrowest scopes the tools need.
      </p>
      <label className={labelClass}>
        Scopes <span className="text-[12px] text-slate-500">(optional, space-separated)</span>
        <input className={inputClass} value={scopeText} placeholder="docs.read" onChange={event => {
          setScopeText(event.target.value);
          const scopes = parseScopes(event.target.value);
          onChange({ scopes: scopes.length ? scopes : undefined });
        }} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          Client id <span className="text-[12px] text-slate-500">(optional; only for a client registered with the provider)</span>
          <input className={inputClass} value={server.clientId ?? ''} autoComplete="off" onChange={event => {
            // The form drops a typed client secret whenever the client id changes.
            onChange({ clientId: event.target.value.trim() || undefined });
          }} />
        </label>
        {server.clientId !== undefined && <ClientSecretField configured={secretConfigured} secret={secret} dropped={secretDropped} onSecret={onSecret} />}
      </div>
      <div className="space-y-1 text-[12px] leading-5 text-slate-600">
        <p>Redirect URI to register with the provider:</p>
        {redirectUri ? <code data-testid="extension-oauth-redirect-uri" className="block break-all rounded bg-white px-2 py-1 text-slate-900">{redirectUri}</code> : <p className="text-amber-800">{NO_PUBLIC_URL}</p>}
        <p>Save the server, then use <strong>Connect</strong> in its row to sign in. Changing the URL, the authentication or the client id requires a new sign-in.</p>
      </div>
      <div className="space-y-2">
        <button type="button" className={buttonClass} disabled={!server.url || !urlValid || check.status === 'running'} onClick={runCheck}>
          {check.status === 'running' ? 'Checking…' : 'Check sign-in'}
        </button>
        <span className={`${hintClass} sm:ml-2 sm:inline`}>Finds the server’s sign-in settings. Nothing is stored.</span>
        {check.status === 'failed' && <p role="alert" className="text-[12px] text-red-800">Check failed: {check.error}</p>}
        {check.result && <OAuthCheckResult result={check.result} />}
      </div>
    </div>
  );
}
