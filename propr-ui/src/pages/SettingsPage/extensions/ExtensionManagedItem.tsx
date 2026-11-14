import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import type { ExtensionLibraryServer, ExtensionManagedBy } from '@propr/shared';
import { ExtensionItemLimits } from './ExtensionItemLimits';
import { buttonClass, primaryButtonClass, type ExtensionChoices, type ItemLimitFields } from './extensionUi';

/** The detail page of a plugin (kept here rather than imported from the Plugins page, which imports this folder). */
const pluginHref = (id: string) => `/plugins/${encodeURIComponent(id)}`;

const badgeClass = 'inline-flex items-center rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-indigo-800 underline-offset-2 hover:underline';
const READ_ONLY_TITLE = 'Its definition comes from the plugin; only enabled, limits and automatic apply can be changed';

/** "From plugin: <name>", linking to the plugin's page. */
export function ManagedItemBadge({ managedBy, pluginName }: { managedBy: ExtensionManagedBy; pluginName?: string }) {
  const routed = useInRouterContext();
  const text = `From plugin: ${pluginName ?? managedBy.plugin}`;
  const href = pluginHref(managedBy.plugin);
  return routed
    ? <Link to={href} data-testid="extension-managed-badge" className={badgeClass} title={READ_ONLY_TITLE}>{text}</Link>
    : <a href={href} data-testid="extension-managed-badge" className={badgeClass} title={READ_ONLY_TITLE}>{text}</a>;
}

/** The note at the top of a managed item's form: what stays read-only and where the definition is changed. */
export function ManagedDefinitionNote({ managedBy, pluginName }: { managedBy: ExtensionManagedBy; pluginName?: string }) {
  return (
    <p data-testid="extension-managed-note" className="rounded-md bg-indigo-50 p-2 text-xs text-indigo-900">
      <ManagedItemBadge managedBy={managedBy} pluginName={pluginName} />{' '}
      Its definition comes from the plugin and is read-only here. Enabled, the limits and automatic apply can be changed;
      uninstalling the plugin removes it.
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="font-medium text-slate-700">{label}</dt><dd className="break-all text-slate-900">{children}</dd></>;
}
const listed = (items: string[]) => (items.length ? items.join(', ') : 'None');

/** A managed server's definition, read-only: the endpoint or package fields the plugin manifest sets. */
export function ManagedServerDefinition({ server }: { server: ExtensionLibraryServer }) {
  return (
    <dl aria-label="Definition from the plugin" data-testid="extension-managed-definition" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <Row label="Server name">{server.name}</Row>
      {server.kind === 'https' && (
        <>
          <Row label="HTTPS endpoint">{server.url}</Row>
          <Row label="Authentication">{({ none: 'None', bearer: 'Bearer token', oauth: 'OAuth sign-in' } as const)[server.authentication]}</Row>
          {server.scopes && <Row label="Scopes">{listed(server.scopes)}</Row>}
        </>
      )}
      {server.kind === 'catalog' && <Row label="Operator catalog entry">{server.catalogId}</Row>}
      {server.kind === 'package' && (
        <>
          <Row label="Registry">{server.ecosystem}</Row>
          <Row label="Package">{server.package}</Row>
          <Row label="Exact version">{server.version}</Row>
          {server.bin && <Row label="Command">{server.bin}</Row>}
          <Row label="Arguments">{listed(server.args)}</Row>
          <Row label="Variables">{listed(server.env.map(variable => `${variable.name}=${variable.value}`))}</Row>
          <Row label="Secret variables">{listed(server.secretEnv)}</Row>
        </>
      )}
      <Row label="Tools">{listed(server.tools)}</Row>
      <Row label="Capability">{server.capability === 'write' ? 'Read and write' : 'Read'}</Row>
    </dl>
  );
}

/**
 * Edit a server a plugin contributes: its definition is shown read-only and only the limits and automatic apply are
 * editable (enabled is switched from the list). Saving writes the library with the definition unchanged.
 */
export function ManagedServerForm({ server, pluginName, choices, onSave, onCancel }: {
  server: ExtensionLibraryServer & { managedBy: ExtensionManagedBy };
  pluginName?: string;
  choices: ExtensionChoices;
  onSave: (server: ExtensionLibraryServer, secrets: Record<string, string>, acknowledged: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [limits, setLimits] = useState<ItemLimitFields>({ repositories: server.repositories, agents: server.agents, autoApply: server.autoApply });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setError('');
    try { await onSave({ ...server, ...limits }, {}, []); }
    catch (e) { setError((e as Error).message); setSaving(false); }
  };
  return (
    <form aria-labelledby={titleId} onSubmit={event => void submit(event)} data-testid="extension-server-form"
      className="space-y-4 rounded-md border border-teal-200 bg-white p-4">
      <h5 id={titleId} className="text-sm font-semibold">Edit server {server.name}</h5>
      <ManagedDefinitionNote managedBy={server.managedBy} pluginName={pluginName} />
      <ManagedServerDefinition server={server} />
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        <ExtensionItemLimits item={limits} choices={choices} onChange={patch => setLimits(value => ({ ...value, ...patch }))} />
      </fieldset>
      {error && <p role="alert" className="rounded-md bg-red-50 p-2 text-sm text-red-800">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButtonClass} disabled={saving}>{saving ? 'Saving…' : 'Save server'}</button>
        <button type="button" className={buttonClass} disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
