import { useId, useState, type FormEvent } from 'react';
import type { ExtensionCatalogEntry, ExtensionLibraryServer, ExtensionSecretAcknowledgement, ExtensionSecretStatus } from '@propr/shared';
import { ExtensionItemLimits } from './ExtensionItemLimits';
import { PackageServerFields } from './ExtensionPackageFields';
import { PACKAGE_TYPE, acknowledgedNames, acknowledgementCovers, packageProblem, serverTypeValue, writeOnlyValues } from './packageServerUi';
import { CatalogServerDetails, ServerAccessFields, ServerEndpointField, ServerToolsField } from './ExtensionServerFields';
import { buttonClass, inputClass, ownEntry, primaryButtonClass, type ExtensionChoices } from './extensionUi';
import { newHttpsServer, newPackageServer } from './libraryEdits';


const fromCatalog = (entry: ExtensionCatalogEntry, base: ExtensionLibraryServer): ExtensionLibraryServer => ({
  kind: 'catalog', name: base.name, catalogId: entry.id, digest: entry.digest, enabled: base.enabled, tools: [...entry.tools], capability: entry.capability,
  repositories: base.repositories, agents: base.agents, autoApply: base.autoApply,
});

/** The name, endpoint, authentication or client changed, so the saved server's credential will not carry over. */
const credentialDropped = (saved: ExtensionLibraryServer | undefined, draft: ExtensionLibraryServer) => saved?.kind === 'https' && draft.kind === 'https'
  && (draft.name !== saved.name || draft.url !== saved.url || draft.authentication !== saved.authentication || draft.clientId !== saved.clientId);

/**
 * Add or edit one MCP server: an HTTPS endpoint or an operator catalog entry,
 * its tools, capability, write-only Bearer token and limits. Saving writes the
 * library at once; the enabled state is changed only from the list.
 */
export function ExtensionServerForm({ initial, servers, catalog, secrets, acknowledgements, choices, redirectUri = null, onSave, onCancel }: {
  /** The saved server being edited; absent for a new one. */
  initial?: ExtensionLibraryServer;
  servers: ExtensionLibraryServer[];
  catalog: ExtensionCatalogEntry[];
  secrets?: Record<string, ExtensionSecretStatus>;
  /** Saved acknowledgements of local package servers' secret variables. */
  acknowledgements?: Record<string, ExtensionSecretAcknowledgement>;
  choices: ExtensionChoices;
  /** The OAuth redirect URI of this instance; null without a public base URL. */
  redirectUri?: string | null;
  /** `secrets` are write-only values by replacement key; `acknowledged` names the server when its secret variables were acknowledged. */
  onSave: (server: ExtensionLibraryServer, secrets: Record<string, string>, acknowledged: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<ExtensionLibraryServer>(() => (initial ? { ...initial } : newHttpsServer(servers)));
  const [token, setToken] = useState('');
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const savedAcknowledgement = initial ? ownEntry(acknowledgements, initial.name) : undefined;
  const [acknowledged, setAcknowledged] = useState(() => acknowledgementCovers(savedAcknowledgement, initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /**
   * A pending token or client secret is meant for the endpoint, authentication and client it was typed for: drop it when
   * any of them changes, including from one client id to another. Scopes and a client id exist only on OAuth servers; an
   * unset optional field is removed.
   */
  const change = (patch: Partial<ExtensionLibraryServer>) => {
    if (draft.kind === 'https' && (['authentication', 'url', 'clientId'] as const).some(key => key in patch && (patch as Record<string, unknown>)[key] !== draft[key])) setToken('');
    setDraft(value => {
      const next = { ...value, ...patch } as Record<string, unknown>;
      if (next.kind === 'https' && next.authentication !== 'oauth') { delete next.scopes; delete next.clientId; }
      for (const key of ['scopes', 'clientId']) if (next[key] === undefined) delete next[key];
      return next as ExtensionLibraryServer;
    });
  };
  const httpsSaved = initial?.kind === 'https' ? initial : undefined;
  const tokenDropped = credentialDropped(httpsSaved, draft);
  const others = servers.filter(server => server.name !== initial?.name);
  const endpoints = [...new Set(servers.flatMap(server => (server.kind === 'https' && server.url ? [server.url] : [])))];
  const knownTools = draft.kind === 'https' ? servers.flatMap(server => (server.kind === 'https' && server.url === draft.url ? server.tools : [])) : [];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (others.some(server => server.name === draft.name)) { setError(`Another server is already named ${draft.name}.`); return; }
    const problem = packageProblem(draft, acknowledged);
    if (problem) { setError(problem); return; }
    const values = writeOnlyValues(draft, token, secretValues);
    setSaving(true); setError('');
    try { await onSave(draft, values, acknowledgedNames(draft, acknowledged)); }
    catch (e) { setError((e as Error).message); setSaving(false); }
  };
  return (
    <form aria-labelledby={titleId} onSubmit={event => void submit(event)} data-testid="extension-server-form"
      className="space-y-4 rounded-md border border-teal-200 bg-white p-4">
      <h5 id={titleId} className="text-sm font-semibold">{initial ? `Edit server ${initial.name}` : 'Add server'}</h5>
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        {!initial && (
          <label className="block text-sm">
            Server type
            <select className={inputClass} value={serverTypeValue(draft)} onChange={event => {
              const entry = catalog.find(item => item.id === event.target.value);
              setToken(''); setSecretValues({}); setAcknowledged(false);
              setDraft(value => (entry ? fromCatalog(entry, value)
                : event.target.value === PACKAGE_TYPE ? { ...newPackageServer(servers, value), name: value.name }
                  : { ...newHttpsServer(servers, value), name: value.name }));
            }}>
              <option value="">HTTPS endpoint</option>
              <option value={PACKAGE_TYPE}>Local package (npm)</option>
              {catalog.map(entry => <option key={entry.id} value={entry.id}>Operator catalog entry: {entry.id}</option>)}
            </select>
          </label>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Server name
            <input className={inputClass} value={draft.name} onChange={event => change({ name: event.target.value })} />
            <span className="mt-1 block text-xs text-slate-500">Lowercase letters, digits, - and _; unique in the library.</span>
          </label>
          <ServerEndpointField server={draft} endpoints={endpoints} onChange={change} />
          <CatalogServerDetails server={draft} catalog={catalog} secrets={secrets} />
        </div>
        {draft.kind === 'package' && (
          <PackageServerFields server={draft} status={ownEntry(secrets, initial?.name ?? '')} acknowledgement={savedAcknowledgement}
            secretValues={secretValues} onSecretValues={setSecretValues} acknowledged={acknowledged} onAcknowledged={setAcknowledged}
            onChange={patch => change(patch as Partial<ExtensionLibraryServer>)} />
        )}
        <ServerToolsField key={draft.kind === 'catalog' ? draft.catalogId : draft.kind} server={draft} catalog={catalog} knownTools={knownTools} onChange={change} />
        <ServerAccessFields server={draft} configured={Boolean(httpsSaved && secrets?.[httpsSaved.name]?.configured)} token={token}
          tokenDropped={tokenDropped} redirectUri={redirectUri} onChange={change} onToken={setToken} />
        <ExtensionItemLimits item={draft} choices={choices} onChange={change} />
      </fieldset>
      {error && <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-800">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButtonClass} disabled={saving}>{saving ? 'Saving…' : initial ? 'Save server' : 'Add server'}</button>
        <button type="button" className={buttonClass} disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
