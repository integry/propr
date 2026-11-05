import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT, calculateJwkThumbprint, decodeJwt } from 'jose';
import { startMcpHttpHarness, type McpHttpHarness } from './fixtures/mcpHttpHarness.js';

// GHSA-rvq5-wwqv-78pq concerns the SDK's requireBearerAuth()/verifyBearerToken(),
// which accepted a token issued for another service. /api/mcp uses neither: it
// authenticates through McpPolicy.authenticate. Local OAuth access tokens are
// opaque digests resolved in this instance's store, and the grant behind each is
// accepted only for this instance and this exact resource (McpOAuthProvider.grant).
// Connect delegations are JWTs whose audience, instance and resource claims are
// all bound. These tests keep both invariants, each beside a valid control.

const connectKey = await generateKeyPair('ES256');
const connectJwk = { ...await exportJWK(connectKey.publicKey), kid: 'audience-key', alg: 'ES256', use: 'sig' };
const connect = { issuer: 'https://mcp.propr.dev', jwks: 'https://mcp.propr.dev/.well-known/jwks.json', installationId: 456, resource: 'https://mcp.propr.dev/mcp', tunnelId: 'tunnel-1', relayToken: 'prt_fixture' };
let validations = 0;

let h: McpHttpHarness;
before(async () => {
  h = await startMcpHttpHarness({
    upstream: request => {
      if (request.url === connect.jwks) return Promise.resolve(Response.json({ keys: [connectJwk] }));
      if (request.url !== `${connect.issuer}/v1/mcp/delegations/validate`) return undefined;
      validations++;
      return request.json().then(body => Response.json({ active: true, ...decodeJwt((body as { delegation: string }).delegation) }));
    },
  });
});
after(async () => {
  await h?.close();
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

const listTools = (token: string) => h.post(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

test('a local OAuth token is accepted only for the grant issued to this instance and this MCP resource', async () => {
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const control = await listTools(h.alpha.token);
  assert.equal(control.status, 200, control.text);
  assert.ok(control.messages[0].result.tools.length > 0);

  const credential = { id: h.alpha.id, login: h.alpha.login, username: h.alpha.login, displayName: 'Alpha', email: null, avatarUrl: null, accessToken: 'github-alpha-user' };
  const issue = async (config: { resource: string; instanceId: string }) => (await new McpOAuthProvider(h.oauth.store, { ...h.config, origin: 'https://instance.example', encryptionKey: Buffer.alloc(32), ...config })
    .issueDelegatedGrant({ credential, clientId: 'other-client', clientName: 'Other', scopes: ['read'], repositories: ['acme/alpha'], membershipSource: 'local', ttlMs: 600_000 })).accessToken;
  // Issued from this very store, for another resource or another instance.
  const otherResource = await issue({ resource: 'https://other.example/api/mcp', instanceId: h.config.instanceId });
  const otherInstance = await issue({ resource: h.config.resource, instanceId: 'another-instance-id' });
  const authenticated = h.githubUserCalls();
  for (const token of [otherResource, otherInstance, `${h.alpha.token}x`, 'propr_mcp_not-issued-here']) {
    const rejected = await listTools(token);
    assert.equal(rejected.status, 401, rejected.text);
    assert.deepEqual(JSON.parse(rejected.text), { error: 'INVALID_TOKEN' });
  }
  assert.equal(h.githubUserCalls(), authenticated, 'a token for another audience never reaches the owner credential');
  const rows = await h.db('mcp_access_log').where({ kind: 'auth' }).orderBy('id').select('outcome', 'error_code', 'owner_id');
  assert.deepEqual(rows.slice(-4), Array(4).fill({ outcome: 'denied', error_code: 'INVALID_TOKEN', owner_id: null }));
  assert.equal((await listTools(h.alpha.token)).status, 200, 'the valid token keeps working');
});

test('a Connect delegation is accepted only for this instance audience and the Connect MCP resource', async () => {
  const { McpPolicy } = await import('../mcp/policy.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { MCP_CONNECT_CONTRACT } = await import('../mcp/connect.js');
  const config = { ...h.config, origin: 'https://instance.example', encryptionKey: Buffer.alloc(32), connect };
  const instanceKey = await generateKeyPair('ES256', { extractable: true });
  const thumbprint = await calculateJwkThumbprint(await exportJWK(instanceKey.publicKey));
  await h.oauth.store.put('connect_identity', 'instance', { instanceId: config.instanceId, privateJwk: await exportJWK(instanceKey.privateKey) });
  await h.oauth.store.put('connect_registration', 'instance', { instanceId: config.instanceId, issuer: connect.issuer, installationId: 456, tunnel_id: 'tunnel-1', key_thumbprint: thumbprint, contract_version: MCP_CONNECT_CONTRACT });
  const policy = new McpPolicy(new McpOAuthProvider(h.oauth.store, config), config);
  const delegation = (claims: Record<string, unknown> = {}, audience = `urn:propr:instance:${config.instanceId}:mcp`) => new SignJWT({
    grant_id: 'connect-grant', instance_id: config.instanceId, installation_id: 456, scopes: ['read'], repositories: ['acme/alpha'],
    contract_version: MCP_CONNECT_CONTRACT, resource: connect.resource, instance_key_thumbprint: thumbprint, ...claims,
  }).setProtectedHeader({ alg: 'ES256', kid: 'audience-key', typ: 'propr-mcp-delegation+jwt' }).setIssuer(connect.issuer).setSubject(h.alpha.id)
    .setAudience(audience).setIssuedAt().setExpirationTime('60s').setJti(crypto.randomUUID()).sign(connectKey.privateKey);

  const valid = await policy.authenticate(await delegation(), connect.resource);
  assert.equal(valid.user.id, h.alpha.id);
  assert.equal(valid.grant.resource, connect.resource);
  const checked = validations;
  const rejected = [
    () => delegation({}, 'urn:propr:instance:another-instance-id:mcp'), // another instance's audience
    () => delegation({}, 'https://other.example/api/mcp'), // another service's audience
    () => delegation({ resource: 'https://other.example/mcp' }), // issued for another resource
    () => delegation({ instance_id: 'another-instance-id' }),
  ];
  for (const issue of rejected) await assert.rejects(policy.authenticate(await issue()), { code: 'INVALID_DELEGATION', status: 401 });
  // The resource the client says it connected to must match the token too.
  await assert.rejects(policy.authenticate(await delegation(), 'https://other.example/mcp'), { code: 'INVALID_DELEGATION', status: 401 });
  assert.equal(validations, checked, 'every mismatch is refused locally, before online validation');
  assert.equal((await policy.authenticate(await delegation())).user.id, h.alpha.id, 'a valid delegation keeps working');
});
