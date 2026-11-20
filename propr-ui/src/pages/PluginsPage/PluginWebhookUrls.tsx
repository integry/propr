import { useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import type { PluginWebhooksView } from '../../api/pluginsApi';
import { usePluginWebhooks } from './usePluginWebhooks';
import { buttonClass, dangerButtonClass, formatWhen } from './pluginUi';

type Endpoint = PluginWebhooksView['webhooks'][number];
const SCHEME_LABELS: Record<Endpoint['scheme'], string> = {
  'hmac-sha256': 'HMAC-SHA256 signature',
  'slack-v0': 'Slack signing secret',
  'token-header': 'Secret token header',
};
const REASONS: Record<string, string> = {
  missing_signature: 'no signature', bad_signature: 'wrong signature', stale_timestamp: 'stale timestamp', no_secret: 'signing secret not set',
};

function CopyUrl({ endpoint }: { endpoint: Endpoint }) {
  const [copied, setCopied] = useState(false);
  const value = endpoint.url ?? endpoint.path;
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => setCopied(false));
  };
  const fieldId = `plugin-webhook-${endpoint.name}`;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <label htmlFor={fieldId} className="sr-only">{`URL of webhook ${endpoint.name}`}</label>
      <input id={fieldId} readOnly value={value} spellCheck={false} onFocus={event => event.currentTarget.select()}
        className="min-w-0 flex-1 rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5 font-mono text-xs text-slate-800" />
      <button type="button" className={buttonClass} onClick={copy} aria-label={`Copy URL of webhook ${endpoint.name}`}>
        {copied ? <Check aria-hidden="true" className="mr-1 inline h-4 w-4" /> : <Copy aria-hidden="true" className="mr-1 inline h-4 w-4" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * Webhooks, in the Connect step: the URL to give each sending service, with Copy, and Regenerate,
 * which replaces the installation key in every URL (the old ones stop working at once).
 */
export function PluginWebhookUrls({ pluginId, installed }: { pluginId: string; installed: boolean }) {
  const { webhooks, error, busy, regenerate } = usePluginWebhooks(pluginId, installed);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  if (!installed) return null;
  const confirm = () => void regenerate().then(ok => { setConfirming(false); if (ok) setNotice('New URLs created. Update them at each sending service; the old URLs no longer work.'); });
  return (
    <section aria-labelledby="plugin-webhooks" data-testid="plugin-webhooks" className="space-y-3 rounded-md border border-slate-200 p-3">
      <div className="space-y-1">
        <h3 id="plugin-webhooks" className="font-medium text-slate-900">Webhook URLs</h3>
        <p className="text-xs text-slate-600">Give each service its URL. ProPR checks every request against the signing secret before the plugin sees it. Keep the URLs private.</p>
      </div>
      {error && <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-800 [overflow-wrap:anywhere]">{error}</p>}
      {!webhooks && !error && <p className="text-sm text-slate-500">Loading webhook URLs…</p>}
      {webhooks && (
        <>
          <ul aria-label="Webhooks" className="space-y-3">
            {webhooks.webhooks.map(endpoint => (
              <li key={endpoint.name} data-testid="plugin-webhook" className="space-y-1">
                <p className="flex flex-wrap items-center gap-x-2 text-sm">
                  <code className="rounded bg-slate-100 px-1 text-xs text-slate-800">{endpoint.name}</code>
                  <span className="text-slate-700 [overflow-wrap:anywhere]">{endpoint.description}</span>
                  <span className="text-xs text-slate-500">{SCHEME_LABELS[endpoint.scheme]}</span>
                </p>
                <CopyUrl endpoint={endpoint} />
              </li>
            ))}
          </ul>
          {webhooks.webhooks.some(endpoint => endpoint.url === null) && (
            <p className="text-xs text-amber-800">This instance has no public base URL, so only the path is shown. Prefix it with the address services reach ProPR at.</p>
          )}
          <p className="text-xs text-slate-600">
            {webhooks.rejected.count === 0
              ? 'No unverified requests.'
              : `${webhooks.rejected.count} unverified ${webhooks.rejected.count === 1 ? 'request' : 'requests'} rejected${webhooks.rejected.lastAt ? `, the last ${formatWhen(webhooks.rejected.lastAt)}` : ''}${webhooks.rejected.lastReason ? ` (${REASONS[webhooks.rejected.lastReason] ?? webhooks.rejected.lastReason})` : ''}.`}
          </p>
          {notice && <p role="status" className="text-sm text-teal-800">{notice}</p>}
          {confirming ? (
            <div role="group" aria-label="Confirm regenerate" className="space-y-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
              <p>Every URL above stops working at once. Services keep failing until you give them the new URLs.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={dangerButtonClass} disabled={busy} onClick={confirm}>Regenerate URLs</button>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className={buttonClass} onClick={() => { setNotice(''); setConfirming(true); }}>
              <RefreshCw aria-hidden="true" className="mr-1 inline h-4 w-4" />Regenerate
            </button>
          )}
        </>
      )}
    </section>
  );
}
