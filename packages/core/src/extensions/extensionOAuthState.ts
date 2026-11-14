import type { Knex } from 'knex';
import type { ExtensionLibraryServer, ExtensionOAuthConnectionState } from '@propr/shared';

/**
 * OAuth connection rows as library resolution and saving see them. A row is
 * bound to the server's endpoint and client: when the server's URL,
 * authentication type or pre-registered client id changes, the row no longer
 * belongs to it and is discarded.
 */
export const OAUTH_CONNECTIONS = 'extension_oauth_connections';
export const OAUTH_PENDING = 'extension_oauth_pending';
export const OAUTH_AUDIT = 'extension_oauth_audit';

export interface OAuthConnectionRow {
  instance_id: string; server_name: string; endpoint: string; state: 'connected' | 'needs_sign_in' | 'disconnecting';
  registration: 'metadata_document' | 'dynamic' | 'preregistered'; client_id: string;
  issuer: string; metadata: string; redirect_uri: string;
  /** The resource identifier declared by the protected resource metadata, sent as `resource` on refresh; may be a parent of `endpoint`. */
  resource: string; sealed: string;
  generation: string; version: number; refresh_lease_until: number | null; refresh_lease_owner: string | null;
  connected_by: string; connected_at: number; updated_at: number;
}

export const hasOAuthTables = async (database: Knex) => database.schema.hasTable(OAUTH_CONNECTIONS);

/** Whether a stored connection still belongs to this library server. */
export function connectionBelongsTo(row: Pick<OAuthConnectionRow, 'endpoint' | 'registration' | 'client_id'>, server: ExtensionLibraryServer | undefined): boolean {
  if (!server || server.kind !== 'https' || server.authentication !== 'oauth' || server.url !== row.endpoint) return false;
  return server.clientId ? row.registration === 'preregistered' && row.client_id === server.clientId : row.registration !== 'preregistered';
}

/** Whether a sign-in started for `endpoint` and pre-registered `clientId` (or none) may still complete for this library server. */
export function signInBelongsTo(server: ExtensionLibraryServer | undefined, endpoint: string, clientId: string | undefined): boolean {
  return !!server && server.kind === 'https' && server.authentication === 'oauth' && server.url === endpoint && (server.clientId ?? undefined) === clientId;
}
const pendingClientId = (details: unknown): string | undefined => {
  try { const value = (JSON.parse(String(details)) as { clientId?: unknown }).clientId; return typeof value === 'string' ? value : undefined; } catch { return undefined; }
};

/** Connection state of every OAuth server in `servers`; servers without a usable connection are not connected. */
export async function oauthConnectionStates(database: Knex, instanceId: string, servers: readonly ExtensionLibraryServer[]): Promise<Record<string, ExtensionOAuthConnectionState>> {
  const oauth = servers.filter(s => s.kind === 'https' && s.authentication === 'oauth');
  const states: Record<string, ExtensionOAuthConnectionState> = Object.create(null);
  if (!oauth.length) return states;
  for (const server of oauth) states[server.name] = 'not_connected';
  if (!await hasOAuthTables(database)) return states;
  const rows = await database(OAUTH_CONNECTIONS).where({ instance_id: instanceId }).whereIn('server_name', oauth.map(s => s.name)) as OAuthConnectionRow[];
  for (const row of rows) {
    const server = oauth.find(s => s.name === row.server_name);
    // A connection being disconnected (or whose Disconnect stopped midway) is unusable; Disconnect stays available to finish it.
    if (connectionBelongsTo(row, server)) states[row.server_name] = row.state === 'connected' ? 'connected' : 'needs_sign_in';
  }
  return states;
}

/**
 * Inside a library save: delete connections whose server was removed, renamed,
 * moved to another URL, switched to another authentication type or client id,
 * and pending sign-ins for such servers. Enabling or disabling keeps them.
 */
export async function discardStaleOAuthConnections(trx: Knex.Transaction, instanceId: string, servers: readonly ExtensionLibraryServer[], actor: string): Promise<string[]> {
  const now = Date.now();
  if (!await hasOAuthTables(trx)) return [];
  const rows = await trx(OAUTH_CONNECTIONS).where({ instance_id: instanceId }) as OAuthConnectionRow[];
  const stale = rows.filter(row => !connectionBelongsTo(row, servers.find(s => s.name === row.server_name))).map(row => row.server_name);
  if (stale.length) {
    await trx(OAUTH_CONNECTIONS).where({ instance_id: instanceId }).whereIn('server_name', stale).delete();
    await trx(OAUTH_AUDIT).insert(stale.map(name => ({ instance_id: instanceId, server_name: name, action: 'discarded', actor, at: now })));
  }
  // Deleting a pending row also cancels a callback that consumed it and is still exchanging its code.
  const pending = await trx(OAUTH_PENDING).where({ instance_id: instanceId }).select('state_hash', 'server_name', 'endpoint', 'details');
  const stalePending = pending.filter(row => !signInBelongsTo(servers.find(s => s.name === row.server_name), row.endpoint, pendingClientId(row.details))).map(row => row.state_hash as string);
  if (stalePending.length) await trx(OAUTH_PENDING).whereIn('state_hash', stalePending).delete();
  return stale;
}

/**
 * Inside a change that replaces the OAuth client of `serverNames` (a client
 * secret rotation keeps everything `connectionBelongsTo` compares): delete
 * their pending sign-ins, then their connections. The pending rows go first:
 * a callback still exchanging a code under the old client then finds its
 * sign-in cancelled, and one that already committed has its connection
 * deleted by the second statement.
 */
export async function discardOAuthConnectionsOf(trx: Knex.Transaction, instanceId: string, serverNames: readonly string[], actor: string): Promise<string[]> {
  if (!serverNames.length || !await hasOAuthTables(trx)) return [];
  await trx(OAUTH_PENDING).where({ instance_id: instanceId }).whereIn('server_name', serverNames).delete();
  const discarded = (await trx(OAUTH_CONNECTIONS).where({ instance_id: instanceId }).whereIn('server_name', serverNames).select('server_name')).map(row => row.server_name as string);
  if (!discarded.length) return [];
  await trx(OAUTH_CONNECTIONS).where({ instance_id: instanceId }).whereIn('server_name', discarded).delete();
  const now = Date.now();
  await trx(OAUTH_AUDIT).insert(discarded.map(name => ({ instance_id: instanceId, server_name: name, action: 'discarded', actor, at: now })));
  return discarded;
}

/** The library view with the current connection state of its enabled OAuth servers, for resolution. */
export async function withOAuthStates<T extends { instanceId: string; servers: ExtensionLibraryServer[] }>(database: Knex, snapshot: T): Promise<T & { oauth: Record<string, ExtensionOAuthConnectionState> }> {
  return { ...snapshot, oauth: await oauthConnectionStates(database, snapshot.instanceId, snapshot.servers.filter(s => s.enabled)) };
}
