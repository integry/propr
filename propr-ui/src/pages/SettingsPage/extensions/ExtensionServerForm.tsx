import { useId, useState, type FormEvent } from 'react';
import type { ExtensionCatalogEntry, ExtensionLibraryServer, ExtensionSecretStatus } from '@propr/shared';
import { ExtensionItemLimits } from './ExtensionItemLimits';
import { CatalogServerDetails, ServerAccessFields, ServerEndpointField, ServerToolsField } from './ExtensionServerFields';
import { buttonClass, inputClass, primaryButtonClass, type ExtensionChoices } from './extensionUi';
import { newHttpsServer } from './libraryEdits';

const fromCatalog = (entry: ExtensionCatalogEntry, base: ExtensionLibraryServer): ExtensionLibraryServer => ({
  kind: 'catalog', name: base.name, catalogId: entry.id, digest: entry.digest, enabled: base.enabled, tools: [...entry.tools], capability: entry.capability,
  repositories: base.repositories, agents: base.agents, autoApply: base.autoApply,
});

/**
 * Add or edit one MCP server: an HTTPS endpoint or an operator catalog entry,
 * its tools, capability, write-only Bearer token and limits. Saving writes the
 * library at once; the enabled state is changed only from the list.
 */
export function ExtensionServerForm({ initial, servers, catalog, secrets, choices, onSave, onCancel }: {
  /** The saved server being edited; absent for a new one. */
  initial?: ExtensionLibraryServer;
  servers: ExtensionLibraryServer[];
  catalog: ExtensionCatalogEntry[];
  secrets?: Record<string, ExtensionSecretStatus>;
  choices: ExtensionChoices;
  onSave: (server: ExtensionLibraryServer, token: string) => Promise<void>;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<ExtensionLibraryServer>(() => (initial ? { ...initial } : newHttpsServer(servers)));
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const change = (patch: Partial<ExtensionLibraryServer>) => setDraft(value => ({ ...value, ...patch } as ExtensionLibraryServer));
  const httpsSaved = initial?.kind === 'https' ? initial : undefined;
  const tokenDropped = Boolean(httpsSaved && (draft.name !== httpsSaved.name || (draft.kind === 'https' && draft.url !== httpsSaved.url)));
  const others = servers.filter(server => server.name !== initial?.name);
  const endpoints = [...new Set(servers.flatMap(server => (server.kind === 'https' && server.url ? [server.url] : [])))];
  const knownTools = draft.kind === 'https' ? servers.flatMap(server => (server.kind === 'https' && server.url === draft.url ? server.tools : [])) : [];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (others.some(server => server.name === draft.name)) { setError(`Another server is already named ${draft.name}.`); return; }
    setSaving(true); setError('');
    try { await onSave(draft, draft.kind === 'https' && draft.authentication === 'bearer' ? token : ''); }
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
            <select className={inputClass} value={draft.kind === 'catalog' ? draft.catalogId : ''} onChange={event => {
              const entry = catalog.find(item => item.id === event.target.value);
              setDraft(value => (entry ? fromCatalog(entry, value) : { ...newHttpsServer(servers, value), name: value.name }));
            }}>
              <option value="">HTTPS endpoint</option>
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
        <ServerToolsField key={draft.kind === 'catalog' ? draft.catalogId : 'https'} server={draft} catalog={catalog} knownTools={knownTools} onChange={change} />
        <ServerAccessFields server={draft} configured={Boolean(httpsSaved && secrets?.[httpsSaved.name]?.configured)} token={token}
          tokenDropped={tokenDropped} onChange={change} onToken={setToken} />
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
