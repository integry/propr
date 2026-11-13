import { useState } from 'react';
import { EXTENSION_LIBRARY_LIMITS, type ExtensionLibraryServer } from '@propr/shared';
import { ExtensionItemRow } from './ExtensionItemRow';
import { ExtensionServerForm } from './ExtensionServerForm';
import { ExtensionOAuthConnection } from './ExtensionOAuthConnection';
import { itemNotes } from './extensionNotes';
import { withServer } from './libraryEdits';
import { RUN_LIMITS, buttonClass, ownEntry, runLimitExcess, serverRef } from './extensionUi';
import type { ExtensionLibraryState } from './useExtensionLibrary';

/** The library's MCP servers: one row each with its enabled switch, and the add/edit form. */
export function ExtensionServersList({ state }: { state: ExtensionLibraryState }) {
  /** The open form and, when editing, the saved server it was opened on. */
  const [editing, setEditing] = useState<{ opened?: ExtensionLibraryServer } | null>(null);
  const library = state.library!;
  const servers = library.servers;
  const full = servers.length >= EXTENSION_LIBRARY_LIMITS.servers;
  const excess = runLimitExcess(servers, state.choices, RUN_LIMITS.servers);
  const save = async (server: ExtensionLibraryServer, token: string) => {
    const opened = editing?.opened;
    await state.save(items => ({ ...items, servers: withServer(items.servers, server, opened) }), token ? { [server.name]: token } : {});
    setEditing(null);
    state.setNotice(opened === undefined ? `Server ${server.name} added.` : `Server ${server.name} saved.`);
  };
  return (
    <section aria-labelledby="extension-servers-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="extension-servers-heading" className="text-sm font-semibold">MCP servers</h4>
        {editing === null && <button type="button" className={buttonClass} disabled={full} onClick={() => setEditing({})}>Add server</button>}
      </div>
      {full && <p className="text-xs text-slate-500">The library holds at most {EXTENSION_LIBRARY_LIMITS.servers} servers.</p>}
      {excess && (
        <p role="note" className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          {excess.count} MCP servers can apply to {excess.repository} with {excess.agent}; only {RUN_LIMITS.servers} are used per run (counting ProPR’s own server).
        </p>
      )}
      {editing && editing.opened === undefined && (
        <ExtensionServerForm servers={servers} catalog={state.catalog} secrets={library.secrets} choices={state.choices} redirectUri={state.oauth.redirectUri} onSave={save} onCancel={() => setEditing(null)} />
      )}
      {servers.length === 0 && !editing && <p className="text-sm text-slate-500">No MCP servers yet.</p>}
      <ul className="space-y-2">
        {servers.map(server => (editing?.opened?.name === server.name ? (
          <li key={server.name}>
            <ExtensionServerForm initial={editing.opened} servers={servers} catalog={state.catalog} secrets={library.secrets} choices={state.choices} redirectUri={state.oauth.redirectUri} onSave={save} onCancel={() => setEditing(null)} />
          </li>
        ) : (
          <ExtensionItemRow key={server.name} testId="extension-server" name={server.name}
            kind={server.kind === 'https' ? (server.authentication === 'oauth' ? 'HTTPS endpoint · OAuth' : 'HTTPS endpoint') : `Operator catalog: ${server.catalogId}`} capability={server.capability}
            item={server} enabled={state.shownEnabled(serverRef(server), server.enabled)} pending={state.isPending(serverRef(server))}
            busy={editing !== null} notes={itemNotes(server, { usage: state.usage, choices: state.choices, secrets: library.secrets })}
            onToggle={enabled => void state.toggle(serverRef(server), server.name, enabled)}
            onEdit={() => setEditing({ opened: server })}
            onRemove={() => void state.remove(serverRef(server), server.name)}>
            {server.kind === 'https' && server.authentication === 'oauth' && (
              <ExtensionOAuthConnection name={server.name} status={ownEntry(state.oauth.connections, server.name)} redirectUri={state.oauth.redirectUri}
                busy={state.isOAuthBusy(server.name) || editing !== null}
                onConnect={() => void state.connectOAuth(server.name)} onDisconnect={() => void state.disconnectOAuth(server.name)} />
            )}
          </ExtensionItemRow>
        )))}
      </ul>
    </section>
  );
}
