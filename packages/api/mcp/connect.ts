import { randomUUID } from 'node:crypto';
import { calculateJwkThumbprint, generateKeyPair, exportJWK, importJWK, SignJWT, type JWK } from 'jose';
import type { GitHubUser } from '../authTypes.js';
import { McpError, type McpConfig } from './config.js';
import { digest, type McpStore } from './store.js';

export const MCP_CONNECT_CONTRACT = 'propr-connect-mcp/1';
export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25'];
export const instanceAudience = (id: string): string => `urn:propr:instance:${id}:mcp`;
export interface InstanceIdentity { instanceId: string; privateJwk: JWK }

let registrationRejectedListener: (() => void) | undefined;
/** Notified when Connect answers 409: it no longer accepts this instance's registration or contract. */
export function onConnectRegistrationRejected(listener: (() => void) | undefined): void {
  registrationRejectedListener = listener;
}

/** Only operator code creates identities; request handling never rotates a key. */
export class McpConnect {
  constructor(readonly config: McpConfig, readonly store: McpStore) {}
  async identity() {
    const identity = await this.store.get<InstanceIdentity>('connect_identity', 'instance');
    if (!identity || identity.instanceId !== this.config.instanceId || identity.privateJwk.kty !== 'EC'
      || identity.privateJwk.crv !== 'P-256' || !identity.privateJwk.d) {
      throw new McpError('CONNECT_SETUP_REQUIRED', 'Connect registration is not complete. Hosted UI tunnel mode registers automatically; otherwise run npm run mcp:connect:register with the instance configuration.', 401);
    }
    const publicJwk: JWK = { kty: 'EC', crv: 'P-256', x: identity.privateJwk.x, y: identity.privateJwk.y };
    return { ...identity, publicJwk, thumbprint: await calculateJwkThumbprint(publicJwk) };
  }
  async assertion(path: string, binding: Record<string, unknown>): Promise<string> {
    const connect = this.config.connect!;
    const identity = await this.identity();
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...binding, installation_id: connect.installationId })
      .setProtectedHeader({ alg: 'ES256', typ: 'propr-instance-assertion+jwt' })
      .setIssuer(instanceAudience(identity.instanceId)).setSubject(identity.instanceId)
      .setAudience(`${connect.issuer}${path}`).setIssuedAt(now).setExpirationTime(now + 60).setJti(randomUUID())
      .sign(await importJWK(identity.privateJwk, 'ES256'));
  }
  async post(path: string, body: Record<string, unknown>, binding: Record<string, unknown>): Promise<Record<string, unknown>> {
    const connect = this.config.connect!;
    const assertion = await this.assertion(path, binding);
    let response: Response;
    try {
      response = await fetch(`${connect.issuer}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${connect.relayToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...body, instance_assertion: assertion }) });
    } catch { throw new McpError('CONNECT_UNAVAILABLE', 'Connect validation is unavailable. No offline access is allowed.', 503); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409) registrationRejectedListener?.();
      throw new McpError(response.status === 409 ? 'INSTANCE_VERSION_MISMATCH' : response.status >= 500 ? 'CONNECT_UNAVAILABLE' : 'ACCESS_REVOKED',
        'Connect rejected the current grant, instance proof or registration. Check setup and reconnect if access was revoked.', response.status === 409 ? 409 : response.status >= 500 ? 503 : 403);
    }
    try {
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new McpError('CONNECT_UNAVAILABLE', 'Connect returned an invalid validation response.', 503); }
  }
  async register(): Promise<void> {
    const identity = await this.identity();
    const connect = this.config.connect!;
    const binding = { tunnel_id: connect.tunnelId, key_thumbprint: identity.thumbprint,
      contract_version: MCP_CONNECT_CONTRACT, protocol_versions: MCP_PROTOCOL_VERSIONS };
    const result = await this.post('/v1/mcp/instances/register', { ...binding, instance_id: identity.instanceId, public_jwk: identity.publicJwk }, binding);
    if (result.registered !== true || result.instance_id !== identity.instanceId || result.audience !== instanceAudience(identity.instanceId)
      || result.contract_version !== MCP_CONNECT_CONTRACT) throw new McpError('CONNECT_SETUP_REQUIRED', 'Connect registration response does not match this instance.', 401);
    await this.store.put('connect_registration', 'instance', { ...binding, issuer: connect.issuer, installationId: connect.installationId,
      instanceId: identity.instanceId, registered_at: Date.now() });
  }
  /** When the current registration receipt was stored, or undefined if it predates the timestamp. */
  async registeredAt(): Promise<number | undefined> {
    const registration = await this.store.get<Record<string, unknown>>('connect_registration', 'instance');
    return typeof registration?.registered_at === 'number' ? registration.registered_at : undefined;
  }
  async registeredThumbprint(): Promise<string> {
    const identity = await this.identity();
    const connect = this.config.connect!;
    const registration = await this.store.get<Record<string, unknown>>('connect_registration', 'instance');
    if (!registration || registration.instanceId !== identity.instanceId || registration.issuer !== connect.issuer
      || registration.installationId !== connect.installationId || registration.tunnel_id !== connect.tunnelId
      || registration.key_thumbprint !== identity.thumbprint || registration.contract_version !== MCP_CONNECT_CONTRACT) {
      throw new McpError('CONNECT_SETUP_REQUIRED', 'Instance identity or tunnel configuration changed. Run MCP registration and obtain fresh consent.', 401);
    }
    return identity.thumbprint;
  }
  online(path: string, delegation: string, extra: Record<string, unknown> = {}) {
    return this.post(path, { ...extra, delegation }, { delegation_sha256: digest(delegation) });
  }
  async credential(delegation: string, subject: string): Promise<GitHubUser> {
    const issued = await this.online('/v1/mcp/credentials', delegation);
    if (typeof issued.code !== 'string' || !/^pia_mcp_[A-Za-z0-9_-]+$/.test(issued.code) || issued.expires_in !== 60
      || issued.redemption_endpoint !== `${this.config.connect!.issuer}/v1/auth/instance-grants/redeem`) {
      throw new McpError('INVALID_DELEGATION', 'Invalid Connect credential handoff.', 401);
    }
    const redeemed = await this.online('/v1/auth/instance-grants/redeem', delegation, { code: issued.code });
    if (redeemed.github_user_id !== subject || typeof redeemed.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(redeemed.username)
      || typeof redeemed.access_token !== 'string' || !redeemed.access_token || /^(?:pmt_|pmr_|pia_|propr_mcp_)/.test(redeemed.access_token)
      || !(redeemed.avatar_url === null || typeof redeemed.avatar_url === 'string')) {
      throw new McpError('INVALID_DELEGATION', 'Credential owner or format does not match the delegation.', 401);
    }
    return { id: subject, username: redeemed.username, login: redeemed.username, displayName: redeemed.username,
      email: null, avatarUrl: redeemed.avatar_url, accessToken: redeemed.access_token, oauthSource: 'connect' };
  }
}

/**
 * Operator command or hosted-tunnel startup; never called by an MCP client request.
 * `replaceIdentity` is only for a tunnel-derived instance id: a re-provisioned
 * tunnel is a new instance to Connect, so it gets a new key. An explicit
 * MCP_INSTANCE_ID never overwrites a persisted identity.
 */
export async function registerMcpInstance(config: McpConfig, store: McpStore, { replaceIdentity = false }: { replaceIdentity?: boolean } = {}): Promise<void> {
  if (!config.connect) throw new Error('MCP Connect trust must be explicitly enabled');
  await store.db.transaction(async tx => {
    const existing = await store.get<InstanceIdentity>('connect_identity', 'instance', tx);
    // A row this key cannot decrypt is not a missing identity: replacing it
    // would destroy the original key, so fail closed until the key is restored.
    if (!existing && await store.has('connect_identity', 'instance', tx)) {
      throw new McpError('KEY_CHANGED', 'The persisted Connect identity cannot be decrypted with the current MCP encryption key. Restore the original key; the identity is not replaced.', 409);
    }
    if (existing) {
      if (existing.instanceId === config.instanceId) return;
      if (!replaceIdentity) throw new Error('MCP_INSTANCE_ID differs from the persisted identity. Restore the original ID.');
    }
    const pair = await generateKeyPair('ES256', { extractable: true });
    await store.put('connect_identity', 'instance', { instanceId: config.instanceId, privateJwk: await exportJWK(pair.privateKey) }, { database: tx });
  });
  await new McpConnect(config, store).register();
}
