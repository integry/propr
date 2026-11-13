import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import type { ExtensionLibraryServer, ExtensionOAuthCheckResult, ExtensionOAuthConnectionStatus } from '@propr/shared';
import logger from '../utils/logger.js';
import { ExtensionError, unsealLibrarySecrets, type ExtensionLibraryStore } from './extensionProfileStore.js';
import { credentialServers } from './extensionCredentials.js';
import { sealExtensionSecrets, unsealExtensionSecrets } from './privateSecrets.js';
import { OAuthNetworkError, createOAuthHttpsTransport, type OAuthTransport } from './extensionOAuthHttp.js';
import {
  OAuthProtocolError, authorizationUrl, chooseRegistration, createPkce, discoverOAuth, exchangeAuthorizationCode, preregisteredClient,
  refreshTokens, registerDynamicClient, revokeToken, type AuthorizationServerMetadata, type OAuthClient, type OAuthTokens,
} from './extensionOAuth.js';
import { OAUTH_AUDIT, OAUTH_CONNECTIONS, OAUTH_PENDING, connectionBelongsTo, hasOAuthTables, type OAuthConnectionRow } from './extensionOAuthState.js';

/** The instance URLs a sign-in needs; both null without a public base URL. */
export interface ExtensionOAuthUrls { redirectUri: string | null; clientMetadataUrl: string | null }
/** Told once when a connection moves to Needs sign-in. */
export type ExtensionOAuthNotifier = (event: { instanceId: string; serverName: string; connectedBy: string; connectedAt: number }) => Promise<void>;
export interface ExtensionOAuthOptions { transport?: OAuthTransport; now?: () => number; notify?: ExtensionOAuthNotifier; refreshAttempts?: number; retryDelayMs?: number }

const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60 * 1000;
const LEASE_MS = 30 * 1000;
const LEASE_WAIT_MS = 15 * 1000;
interface SealedTokens extends OAuthTokens { clientSecret?: string }
interface PendingDetails { issuer: string; metadata: AuthorizationServerMetadata; client: Omit<OAuthClient, 'clientSecret'>; scopes: string[]; redirectUri: string; resource: string; clientId?: string }
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sessionHash = (sessionId: string) => sha256(`propr.extension-oauth.session\0${sessionId}`);
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Sealed tokens open only for this instance, server, endpoint and client. */
const connectionIdentity = (row: Pick<OAuthConnectionRow, 'instance_id' | 'server_name' | 'endpoint' | 'client_id'>) => `extension-oauth/${row.instance_id}/${row.server_name}/${row.endpoint}/${row.client_id}`;
const pendingIdentity = (instanceId: string, name: string, stateHash: string) => `extension-oauth-pending/${instanceId}/${name}/${stateHash}`;
const isOAuthServer = (server: ExtensionLibraryServer | undefined): server is Extract<ExtensionLibraryServer, { kind: 'https' }> => server?.kind === 'https' && server.authentication === 'oauth';
/** Refreshes in flight in this process, per item; a second caller waits for the first result. */
const inFlight = new Map<string, Promise<string>>();

const oauthStores = new WeakMap<ExtensionLibraryStore, ExtensionOAuthStore>();
/** The OAuth store of a library store, created on first use. */
export function extensionOAuth(store: ExtensionLibraryStore): ExtensionOAuthStore {
  let oauth = oauthStores.get(store);
  if (!oauth) oauthStores.set(store, oauth = new ExtensionOAuthStore(store));
  return oauth;
}
/** Use `oauth` for this library store, for example with an injected transport. */
export const setExtensionOAuth = (store: ExtensionLibraryStore, oauth: ExtensionOAuthStore) => { oauthStores.set(store, oauth); };

/**
 * The current library server named `name` and its administrator-entered
 * credential (for OAuth: the pre-registered client secret). Never authorizes.
 */
async function currentServerCredential(library: ExtensionLibraryStore, name: string): Promise<{ instanceId: string; server: ExtensionLibraryServer | undefined; secret: string | undefined }> {
  const head = await library.head();
  const { instanceId, revision } = head.snapshot;
  const server = head.snapshot.servers.find(s => s.name === name);
  const secrets = server && credentialServers([server]).length ? unsealLibrarySecrets(head.secretsEncrypted, instanceId, revision, library.environment) : {};
  return { instanceId, server, secret: server && Object.hasOwn(secrets, name) ? secrets[name] : undefined };
}

/**
 * Sign-in and token custody for OAuth library servers. Tokens are sealed with
 * the extension private-secret mechanism, bound to the instance, the item and
 * the endpoint and client they were issued for, and never leave Core: no
 * method returns them except to the gateway's upstream call.
 */
export class ExtensionOAuthStore {
  readonly transport: OAuthTransport;
  private readonly now: () => number;
  constructor(readonly library: ExtensionLibraryStore, private readonly options: ExtensionOAuthOptions = {}) {
    this.transport = options.transport ?? createOAuthHttpsTransport();
    this.now = options.now ?? Date.now;
  }
  private get database(): Knex { return this.library.database; }
  private get environment() { return this.library.environment; }
  private async tables() { if (!await hasOAuthTables(this.database)) throw new ExtensionError(503, 'OAuth sign-in storage unavailable'); }

  /** Run discovery for a server form; nothing is stored. */
  async check(actor: string, input: { url: string; clientId?: string; scopes?: string[] }, urls: ExtensionOAuthUrls): Promise<ExtensionOAuthCheckResult> {
    await this.library.authorize(actor);
    let discovery;
    try { discovery = await discoverOAuth(this.transport, input.url, input.scopes); }
    catch (error) { throw new ExtensionError(502, error instanceof OAuthProtocolError || error instanceof OAuthNetworkError ? error.message : 'OAuth discovery failed'); }
    await this.library.authorize(actor);
    if (!discovery) return { authorizationRequired: false, registration: null, message: 'The server answered without requiring authorization. Use authentication None.', redirectUri: urls.redirectUri };
    const registration = chooseRegistration(discovery.metadata, { clientId: input.clientId, clientMetadataUrl: urls.clientMetadataUrl });
    const messages = {
      metadata_document: 'Sign-in will identify ProPR by its Client ID Metadata Document.',
      dynamic: 'Sign-in will register ProPR with the authorization server (Dynamic Client Registration).',
      preregistered: 'Sign-in will use the client id you entered. Register the redirect URI below with the provider.',
    } as const;
    const message = registration ? messages[registration]
      : `The authorization server supports no automatic client registration${discovery.metadata.client_id_metadata_document_supported && !urls.clientMetadataUrl ? ' that this instance can use without a public base URL' : ''}. Register a client in the provider's developer console and enter its client id, or use a static Bearer token if the provider offers one.`;
    return { authorizationRequired: true, discoveredFrom: discovery.discoveredFrom, resource: discovery.resource, issuer: discovery.issuer, scopes: discovery.scopes, registration, message, redirectUri: urls.redirectUri };
  }

  /** Public connection status of every OAuth server in `servers`. */
  async statuses(instanceId: string, servers: readonly ExtensionLibraryServer[]): Promise<Record<string, ExtensionOAuthConnectionStatus>> {
    const oauth = servers.filter(isOAuthServer);
    const result: Record<string, ExtensionOAuthConnectionStatus> = Object.create(null);
    for (const server of oauth) result[server.name] = { state: 'not_connected' };
    if (!oauth.length || !await hasOAuthTables(this.database)) return result;
    const rows = await this.database(OAUTH_CONNECTIONS).where({ instance_id: instanceId }).whereIn('server_name', oauth.map(s => s.name)) as OAuthConnectionRow[];
    for (const row of rows) {
      if (!connectionBelongsTo(row, oauth.find(s => s.name === row.server_name))) continue;
      let scopes: string[] = [];
      let state = row.state;
      try { scopes = this.unsealTokens(row).scopes; } catch { state = 'needs_sign_in'; }
      result[row.server_name] = { state, connectedBy: row.connected_by, connectedAt: Number(row.connected_at), scopes, registration: row.registration };
    }
    return result;
  }

  /** Start a sign-in: the authorization URL to open, with a single-use state bound to this session, item and endpoint. */
  async startSignIn(actor: string, sessionId: string, name: string, urls: ExtensionOAuthUrls): Promise<{ authorizationUrl: string }> {
    if (!urls.redirectUri) throw new ExtensionError(409, 'Connect requires a public HTTPS base URL for this instance (API_PUBLIC_URL)');
    if (typeof sessionId !== 'string' || !sessionId) throw new ExtensionError(403, 'Sign-in requires a browser session');
    await this.library.authorize(actor); await this.tables();
    const { instanceId, server, secret } = await currentServerCredential(this.library, name);
    if (!isOAuthServer(server)) throw new ExtensionError(404, 'OAuth library server unavailable');
    let discovery;
    try { discovery = await discoverOAuth(this.transport, server.url, server.scopes); }
    catch (error) { throw new ExtensionError(502, error instanceof OAuthProtocolError || error instanceof OAuthNetworkError ? error.message : 'OAuth discovery failed'); }
    if (!discovery) throw new ExtensionError(409, 'The server answered without requiring authorization');
    const registration = chooseRegistration(discovery.metadata, { clientId: server.clientId, clientMetadataUrl: urls.clientMetadataUrl });
    let client: OAuthClient;
    if (registration === 'preregistered') client = preregisteredClient(discovery.metadata, server.clientId!, secret);
    else if (registration === 'metadata_document') client = { registration, clientId: urls.clientMetadataUrl!, authMethod: 'none' };
    else if (registration === 'dynamic') client = await this.dynamicClient(instanceId, server, discovery.metadata, urls.redirectUri);
    else throw new ExtensionError(409, 'The authorization server supports no client registration ProPR can use. Enter a pre-registered client id, or use a Bearer token.');
    const state = randomBytes(32).toString('base64url'); const stateHash = sha256(state);
    const pkce = createPkce();
    const { clientSecret, ...publicClient } = client;
    const details: PendingDetails = { issuer: discovery.issuer, metadata: discovery.metadata, client: publicClient, scopes: discovery.scopes, redirectUri: urls.redirectUri, resource: server.url, ...(server.clientId ? { clientId: server.clientId } : {}) };
    await this.library.authorize(actor);
    await this.database(OAUTH_PENDING).where('expires_at', '<=', this.now()).delete();
    await this.database(OAUTH_PENDING).insert({
      state_hash: stateHash, instance_id: instanceId, server_name: server.name, endpoint: server.url, actor, session_hash: sessionHash(sessionId),
      // A dynamically registered secret is sealed with the verifier; a pre-registered one is read from the library at the callback.
      sealed: sealExtensionSecrets({ verifier: pkce.verifier, ...(registration === 'dynamic' && clientSecret ? { clientSecret } : {}) }, pendingIdentity(instanceId, server.name, stateHash), this.environment),
      details: JSON.stringify(details), expires_at: this.now() + STATE_TTL_MS,
    });
    return { authorizationUrl: authorizationUrl(discovery.metadata, { clientId: client.clientId, redirectUri: urls.redirectUri, challenge: pkce.challenge, state, resource: server.url, scopes: discovery.scopes }) };
  }
  /** Reuse this item's dynamic registration with the same issuer and redirect URI; register otherwise. */
  private async dynamicClient(instanceId: string, server: ExtensionLibraryServer, metadata: AuthorizationServerMetadata, redirectUri: string): Promise<OAuthClient> {
    const row = await this.database(OAUTH_CONNECTIONS).where({ instance_id: instanceId, server_name: server.name }).first() as OAuthConnectionRow | undefined;
    if (row && row.registration === 'dynamic' && row.issuer === metadata.issuer && row.redirect_uri === redirectUri && connectionBelongsTo(row, server)) {
      try {
        const sealed = this.unsealTokens(row); const stored = JSON.parse(row.metadata) as { authMethod?: OAuthClient['authMethod'] };
        return { registration: 'dynamic', clientId: row.client_id, ...(sealed.clientSecret ? { clientSecret: sealed.clientSecret } : {}), authMethod: stored.authMethod ?? 'none' };
      } catch { /* register again */ }
    }
    try { return await registerDynamicClient(this.transport, metadata, redirectUri); }
    catch (error) { throw new ExtensionError(502, error instanceof OAuthProtocolError || error instanceof OAuthNetworkError ? error.message : 'Client registration failed'); }
  }

  /**
   * Complete a sign-in from the provider's redirect. The state must be known,
   * unused, unexpired and started by this administrator in this session for
   * the same item and endpoint; `iss` must name the issuer when supplied (and
   * when the server promises it). Nothing is stored unless the code exchange succeeds.
   */
  // eslint-disable-next-line complexity -- every callback check refuses before the exchange
  async completeSignIn(actor: string, sessionId: string, query: { state?: unknown; code?: unknown; error?: unknown; iss?: unknown }): Promise<{ name: string }> {
    await this.tables();
    if (typeof query.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(query.state)) throw new ExtensionError(400, 'Unknown, used or expired sign-in request');
    const stateHash = sha256(query.state);
    const row = await this.database.transaction(async trx => {
      const found = await trx(OAUTH_PENDING).where({ state_hash: stateHash }).first();
      // Single use: the first callback deletes the state, whatever its outcome.
      if (!found || await trx(OAUTH_PENDING).where({ state_hash: stateHash }).delete() !== 1) return undefined;
      return found as { instance_id: string; server_name: string; endpoint: string; actor: string; session_hash: string; sealed: string; details: string; expires_at: number };
    });
    if (!row || Number(row.expires_at) <= this.now()) throw new ExtensionError(400, 'Unknown, used or expired sign-in request');
    if (typeof sessionId !== 'string' || !sessionId || row.actor !== actor || !sameHash(row.session_hash, sessionHash(sessionId))) throw new ExtensionError(403, 'This sign-in was started in another session');
    await this.library.authorize(actor);
    if (query.error !== undefined) throw new ExtensionError(400, 'The provider did not authorize the sign-in');
    if (typeof query.code !== 'string' || !query.code || query.code.length > 4096) throw new ExtensionError(400, 'The provider returned no authorization code');
    const details = JSON.parse(row.details) as PendingDetails;
    // RFC 9207: a mismatched issuer is a mix-up attack; a promised but missing one is refused too.
    if (query.iss !== undefined ? query.iss !== details.issuer : details.metadata.authorization_response_iss_parameter_supported) throw new ExtensionError(400, 'The authorization response came from another issuer');
    const { server, secret } = await currentServerCredential(this.library, row.server_name);
    if (!isOAuthServer(server) || server.url !== row.endpoint || (server.clientId ?? undefined) !== details.clientId) throw new ExtensionError(409, 'The server changed during sign-in; connect again');
    const sealed = unsealExtensionSecrets(row.sealed, pendingIdentity(row.instance_id, row.server_name, stateHash), this.environment);
    const client: OAuthClient = { ...details.client, ...(details.client.registration === 'preregistered' ? (secret ? { clientSecret: secret } : {}) : sealed.clientSecret ? { clientSecret: sealed.clientSecret } : {}) };
    let tokens: OAuthTokens;
    try { tokens = await exchangeAuthorizationCode(this.transport, details.metadata, client, { code: query.code, verifier: sealed.verifier, redirectUri: details.redirectUri, resource: details.resource }, this.now()); }
    catch (error) { throw new ExtensionError(502, error instanceof OAuthProtocolError || error instanceof OAuthNetworkError ? 'The authorization server refused the sign-in' : 'Sign-in failed'); }
    if (!tokens.scopes.length) tokens = { ...tokens, scopes: details.scopes };
    const now = this.now();
    const identity = { instance_id: row.instance_id, server_name: row.server_name, endpoint: row.endpoint, client_id: client.clientId };
    const values = {
      ...identity, state: 'connected', registration: client.registration, issuer: details.issuer,
      metadata: JSON.stringify({ ...details.metadata, authMethod: client.authMethod }), redirect_uri: details.redirectUri,
      sealed: sealExtensionSecrets(this.tokenFields({ ...tokens, ...(client.registration === 'dynamic' && client.clientSecret ? { clientSecret: client.clientSecret } : {}) }), connectionIdentity(identity), this.environment),
      refresh_lease_until: null, connected_by: actor, connected_at: now, updated_at: now,
    };
    await this.database.transaction(async trx => {
      await this.library.authorize(actor, trx);
      const existing = await trx(OAUTH_CONNECTIONS).where({ instance_id: row.instance_id, server_name: row.server_name }).first('version');
      if (existing) await trx(OAUTH_CONNECTIONS).where({ instance_id: row.instance_id, server_name: row.server_name }).update({ ...values, version: Number(existing.version) + 1 });
      else await trx(OAUTH_CONNECTIONS).insert({ ...values, version: 1 });
      await trx(OAUTH_AUDIT).insert({ instance_id: row.instance_id, server_name: row.server_name, action: 'connect', actor, at: now });
    });
    logger.info({ server: row.server_name, registration: client.registration }, 'Extension OAuth server connected');
    return { name: row.server_name };
  }

  /** Revoke at the provider when it advertises revocation, then delete the stored tokens. */
  async disconnect(actor: string, name: string): Promise<{ revoked: boolean }> {
    await this.library.authorize(actor); await this.tables();
    const instanceId = await this.library.instanceId();
    const row = await this.database(OAUTH_CONNECTIONS).where({ instance_id: instanceId, server_name: name }).first() as OAuthConnectionRow | undefined;
    let revoked = false;
    if (row) {
      try {
        const tokens = this.unsealTokens(row);
        const client = await this.clientFor(row, tokens);
        const metadata = JSON.parse(row.metadata) as AuthorizationServerMetadata;
        if (tokens.refreshToken) revoked = await revokeToken(this.transport, metadata, client, { token: tokens.refreshToken, hint: 'refresh_token' });
        revoked = (await revokeToken(this.transport, metadata, client, { token: tokens.accessToken, hint: 'access_token' })) || revoked;
      } catch { /* undecryptable or unrevocable tokens are still deleted */ }
    }
    await this.database.transaction(async trx => {
      await this.library.authorize(actor, trx);
      await trx(OAUTH_CONNECTIONS).where({ instance_id: instanceId, server_name: name }).delete();
      await trx(OAUTH_PENDING).where({ instance_id: instanceId, server_name: name }).delete();
      if (row) await trx(OAUTH_AUDIT).insert({ instance_id: instanceId, server_name: name, action: 'disconnect', actor, at: this.now() });
    });
    return { revoked };
  }

  /** The connect, disconnect and Needs sign-in history of the instance, newest first. */
  async audit(actor: string, limit = 100): Promise<{ server: string; action: string; actor: string; at: number }[]> {
    await this.library.authorize(actor);
    if (!await hasOAuthTables(this.database)) return [];
    const rows = await this.database(OAUTH_AUDIT).where({ instance_id: await this.library.instanceId() }).orderBy('id', 'desc').limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(row => ({ server: row.server_name, action: row.action, actor: row.actor, at: Number(row.at) }));
  }

  /**
   * A current access token for an upstream call of the gateway, refreshed
   * shortly before it expires. Never leaves Core.
   */
  async accessToken(instanceId: string, server: ExtensionLibraryServer): Promise<string> {
    const row = await this.connectedRow(instanceId, server);
    const tokens = this.unsealTokens(row);
    if (tokens.expiresAt === null || tokens.expiresAt - REFRESH_MARGIN_MS > this.now()) return tokens.accessToken;
    try { return await this.refresh(instanceId, server, tokens.accessToken); }
    catch (error) {
      // A transient failure keeps a token that has not yet expired.
      if (error instanceof OAuthNetworkError && tokens.expiresAt > this.now()) return tokens.accessToken;
      throw error;
    }
  }
  /** After an upstream 401 with `rejected`: one refresh, unless another caller already replaced that token. */
  async refreshAfterRejection(instanceId: string, server: ExtensionLibraryServer, rejected: string): Promise<string> {
    return this.refresh(instanceId, server, rejected);
  }

  private async connectedRow(instanceId: string, server: ExtensionLibraryServer): Promise<OAuthConnectionRow> {
    if (!await hasOAuthTables(this.database)) throw new ExtensionError(502, 'OAuth connection unavailable');
    const row = await this.database(OAUTH_CONNECTIONS).where({ instance_id: instanceId, server_name: server.name }).first() as OAuthConnectionRow | undefined;
    if (!row || row.state !== 'connected' || !connectionBelongsTo(row, server)) throw new ExtensionError(502, 'OAuth connection unavailable');
    return row;
  }
  /** Single-flight per item, in this process and across processes through the refresh lease. */
  private refresh(instanceId: string, server: ExtensionLibraryServer, replacing: string): Promise<string> {
    const key = `${instanceId}/${server.name}`;
    const running = inFlight.get(key);
    if (running) return running;
    const work = this.refreshOnce(instanceId, server, replacing).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return work;
  }
  private async refreshOnce(instanceId: string, server: ExtensionLibraryServer, replacing: string): Promise<string> {
    const key = { instance_id: instanceId, server_name: server.name };
    let row = await this.connectedRow(instanceId, server);
    let tokens = this.unsealTokens(row);
    // Another caller already rotated the token this caller saw.
    if (tokens.accessToken !== replacing) return tokens.accessToken;
    const version = Number(row.version);
    const leased = await this.database(OAUTH_CONNECTIONS).where({ ...key, version, state: 'connected' })
      .where(q => q.whereNull('refresh_lease_until').orWhere('refresh_lease_until', '<', this.now())).update({ refresh_lease_until: this.now() + LEASE_MS });
    if (!leased) {
      // Another process holds the lease: wait for its result.
      const deadline = this.now() + LEASE_WAIT_MS;
      while (this.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        row = await this.connectedRow(instanceId, server);
        if (Number(row.version) !== version) return this.unsealTokens(row).accessToken;
      }
      throw new OAuthNetworkError('OAuth refresh did not complete');
    }
    const release = () => this.database(OAUTH_CONNECTIONS).where({ ...key, version }).update({ refresh_lease_until: null });
    if (!tokens.refreshToken) { await this.needsSignIn(row); throw new OAuthProtocolError('The connection has no refresh token', true); }
    const metadata = JSON.parse(row.metadata) as AuthorizationServerMetadata;
    let refreshed: OAuthTokens | undefined;
    const attempts = this.options.refreshAttempts ?? 3;
    for (let attempt = 1; !refreshed; attempt++) {
      try { refreshed = await refreshTokens(this.transport, metadata, await this.clientFor(row, tokens), { refreshToken: tokens.refreshToken, resource: row.endpoint }, this.now()); }
      catch (error) {
        if (error instanceof OAuthProtocolError && error.authorization) { await this.needsSignIn(row); throw error; }
        if (attempt >= attempts) { await release(); logger.warn({ server: server.name }, 'Extension OAuth refresh failed; the connection is unchanged'); throw error instanceof OAuthNetworkError ? error : new OAuthNetworkError('OAuth refresh failed'); }
        await new Promise(resolve => setTimeout(resolve, (this.options.retryDelayMs ?? 250) * attempt));
      }
    }
    // A server that does not rotate keeps the old refresh token (RFC 6749 section 6).
    tokens = { ...tokens, ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken, scopes: refreshed.scopes.length ? refreshed.scopes : tokens.scopes };
    // The new access token and the rotated refresh token are written together, fenced on the version read.
    const written = await this.database(OAUTH_CONNECTIONS).where({ ...key, version }).update({
      sealed: sealExtensionSecrets(this.tokenFields(tokens), connectionIdentity(row), this.environment), version: version + 1, refresh_lease_until: null, updated_at: this.now(),
    });
    if (!written) throw new OAuthNetworkError('OAuth connection changed during refresh');
    return tokens.accessToken;
  }
  /** Move to Needs sign-in once; only the caller that makes the transition notifies. */
  private async needsSignIn(row: OAuthConnectionRow): Promise<void> {
    const key = { instance_id: row.instance_id, server_name: row.server_name };
    const changed = await this.database(OAUTH_CONNECTIONS).where({ ...key, state: 'connected', version: row.version }).update({ state: 'needs_sign_in', refresh_lease_until: null, version: Number(row.version) + 1, updated_at: this.now() });
    if (!changed) return;
    await this.database(OAUTH_AUDIT).insert({ ...key, action: 'needs_sign_in', actor: 'system', at: this.now() });
    logger.warn({ server: row.server_name }, 'Extension OAuth server needs a new sign-in');
    try { await (this.options.notify ?? notifyAdministrators(this.database))({ instanceId: row.instance_id, serverName: row.server_name, connectedBy: row.connected_by, connectedAt: Number(row.connected_at) }); }
    catch { logger.warn({ server: row.server_name }, 'Could not notify administrators that an extension OAuth server needs sign-in'); }
  }
  private async clientFor(row: OAuthConnectionRow, tokens: SealedTokens): Promise<OAuthClient> {
    const authMethod = (JSON.parse(row.metadata) as { authMethod?: OAuthClient['authMethod'] }).authMethod ?? 'none';
    if (row.registration === 'preregistered') {
      const { secret } = await currentServerCredential(this.library, row.server_name);
      return { registration: 'preregistered', clientId: row.client_id, ...(secret ? { clientSecret: secret, authMethod: authMethod === 'none' ? 'client_secret_basic' : authMethod } : { authMethod: 'none' }) };
    }
    return { registration: row.registration, clientId: row.client_id, ...(tokens.clientSecret ? { clientSecret: tokens.clientSecret } : {}), authMethod };
  }
  private tokenFields(tokens: SealedTokens): Record<string, string> {
    return {
      accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: tokens.expiresAt === null ? '' : String(tokens.expiresAt), scopes: tokens.scopes.join(' '),
      ...(tokens.clientSecret ? { clientSecret: tokens.clientSecret } : {}),
    };
  }
  private unsealTokens(row: OAuthConnectionRow): SealedTokens {
    const fields = unsealExtensionSecrets(row.sealed, connectionIdentity(row), this.environment);
    return {
      accessToken: fields.accessToken, ...(fields.refreshToken ? { refreshToken: fields.refreshToken } : {}),
      expiresAt: fields.expiresAt ? Number(fields.expiresAt) : null, scopes: fields.scopes ? fields.scopes.split(' ') : [],
      ...(fields.clientSecret ? { clientSecret: fields.clientSecret } : {}),
    };
  }
}

/** One Inbox notification per transition, to every durable administrator. */
function notifyAdministrators(database: Knex): ExtensionOAuthNotifier {
  return async ({ instanceId, serverName, connectedAt }) => {
    const rows = await database('instance_members').distinct('github_user_id').where({ role: 'admin' }) as { github_user_id?: unknown }[];
    const recipients = rows.flatMap(row => (typeof row.github_user_id === 'string' ? [{ userId: row.github_user_id, pushEnabled: true }] : []));
    if (!recipients.length) return;
    const { createNotificationEvent } = await import('../services/notificationService.js');
    await createNotificationEvent({
      deduplicationKey: `extension-oauth-needs-sign-in:${instanceId}:${serverName}:${connectedAt}`,
      kind: 'system_failure', severity: 'warning',
      target: { type: 'system_failure', component: 'extensions.oauth', correlationId: serverName },
      title: `MCP server ${serverName} needs a new sign-in`,
      body: `The authorization server refused to refresh the connection of ${serverName}. Runs skip this server until an administrator reconnects it in Settings → Skills & MCP servers.`,
      actions: ['dismiss'], metadata: { server: serverName },
    }, recipients);
  };
}
