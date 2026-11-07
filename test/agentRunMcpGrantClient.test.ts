import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { signAgentRunGrantRequest } from '@propr/core';

const { agentContainerMcpUrl, requestAgentRunMcpGrant, revokeAgentRunMcpGrant, revokeGrantQuietly, AgentRunMcpGrantError } = await import('../src/jobs/agentRuns/mcpGrantClient.ts');

// Importing @propr/core opens the shared database connection.
after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

const NOW = 1_800_000_000_000;

function recorder(response: Response | (() => Response)) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return typeof response === 'function' ? response() : response.clone();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('the container URL defaults to the internal API on the Docker network', () => {
  assert.equal(agentContainerMcpUrl({}), 'http://api:4000/api/mcp');
  assert.equal(agentContainerMcpUrl({ PROPR_INTERNAL_API_URL: 'http://propr-api:4000/' }), 'http://propr-api:4000/api/mcp');
  assert.equal(agentContainerMcpUrl({ PROPR_AGENT_MCP_URL: 'http://gateway/api/mcp' }), 'http://gateway/api/mcp');
});

test('grant requests are signed over run id, phase and timestamp', async () => {
  const { calls, fetchImpl } = recorder(Response.json({ grantId: 'g-1', url: 'http://api:4000/api/mcp', token: 'propr_mcp_x', expiresAt: NOW + 1 }));
  const environment = { SYSTEM_TASK_SECRET: 'secret', PROPR_INTERNAL_API_URL: 'http://propr-api:4000' };
  const grant = await requestAgentRunMcpGrant('run/1', 'action', { environment, fetchImpl, now: () => NOW, resolveNetwork: async () => 'propr_propr-agent-mcp' });
  assert.deepEqual(grant, { grantId: 'g-1', phase: 'action', url: 'http://api:4000/api/mcp', token: 'propr_mcp_x', expiresAt: NOW + 1, network: 'propr_propr-agent-mcp' });
  assert.equal(calls[0].url, 'http://propr-api:4000/api/internal/agent-runs/run%2F1/mcp-grants');
  assert.deepEqual(calls[0].body, { phase: 'action', ts: NOW, signature: signAgentRunGrantRequest('secret', 'run/1', 'action', NOW) });

  await revokeAgentRunMcpGrant('run/1', grant, { environment, fetchImpl, now: () => NOW });
  assert.equal(calls[1].url, 'http://propr-api:4000/api/internal/agent-runs/run%2F1/mcp-grants/revoke');
  assert.deepEqual(calls[1].body, { phase: 'action', grantId: 'g-1', ts: NOW, signature: signAgentRunGrantRequest('secret', 'run/1', 'action', NOW) });

  await revokeAgentRunMcpGrant('run/1', { phase: 'report', expiredBy: NOW - 1 }, { environment, fetchImpl, now: () => NOW });
  assert.deepEqual(calls[2].body, { phase: 'report', expiredBy: NOW - 1, ts: NOW, signature: signAgentRunGrantRequest('secret', 'run/1', 'report', NOW) });
});

test('API rejections and a missing secret surface as typed errors without the token', async () => {
  const { fetchImpl } = recorder(() => Response.json({ error: 'INVALID_RUN_STATE', message: 'run is completed' }, { status: 409 }));
  await assert.rejects(requestAgentRunMcpGrant('run-1', 'report', { environment: { SYSTEM_TASK_SECRET: 's' }, fetchImpl }),
    (error: InstanceType<typeof AgentRunMcpGrantError>) => error.status === 409 && error.code === 'INVALID_RUN_STATE');
  await assert.rejects(requestAgentRunMcpGrant('run-1', 'report', { environment: {}, fetchImpl }), { code: 'SYSTEM_TASK_SECRET_MISSING' });
});

test('revocation reports how much the grant was used, and an unused grant is logged as unreachable', async () => {
  const environment = { SYSTEM_TASK_SECRET: 'secret' };
  const grant = { grantId: 'g-1', phase: 'report' as const, url: 'http://api:4000/api/mcp', token: 'propr_mcp_x', expiresAt: NOW + 1, network: 'propr_propr-agent-mcp' };

  const used = recorder(Response.json({ revoked: true, grantId: 'g-1', calls: 3 }));
  assert.deepEqual(await revokeAgentRunMcpGrant('run-1', grant, { environment, fetchImpl: used.fetchImpl, now: () => NOW }), { revoked: true, grantId: 'g-1', calls: 3 });

  const legacy = recorder(Response.json({ revoked: false, grantId: null }));
  assert.deepEqual(await revokeAgentRunMcpGrant('run-1', grant, { environment, fetchImpl: legacy.fetchImpl, now: () => NOW }), { revoked: false, grantId: null, calls: null });

  const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const log = { warn: (fields: Record<string, unknown>, message: string) => { warnings.push({ fields, message }); } };
  await revokeGrantQuietly(async () => ({ revoked: true, grantId: 'g-1', calls: 0 }), 'run-1', grant, log);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /without a single recorded call/);
  assert.equal(warnings[0].fields.mcpUrl, grant.url);
  assert.equal(warnings[0].fields.network, 'propr_propr-agent-mcp');
  assert.ok(!JSON.stringify(warnings).includes('propr_mcp_x'));

  warnings.length = 0;
  await revokeGrantQuietly(async () => ({ revoked: true, grantId: 'g-1', calls: 2 }), 'run-1', grant, log);
  await revokeGrantQuietly(async () => ({ revoked: true, grantId: 'g-1', calls: null }), 'run-1', grant, log);
  await revokeGrantQuietly(async () => undefined as never, 'run-1', grant, log);
  assert.equal(warnings.length, 0);
});

for (const phase of ['report', 'action'] as const) {
  test(`${phase} grants with an explicit MCP URL skip network discovery unless a network is pinned`, async () => {
    const { fetchImpl } = recorder(Response.json({ grantId: 'g-1', url: 'http://api:4000/api/mcp', token: 'propr_mcp_x', expiresAt: NOW + 1 }));
    const environment = { SYSTEM_TASK_SECRET: 'secret', PROPR_AGENT_MCP_URL: 'https://mcp.example/api/mcp' };
    let discoveries = 0;
    const resolveNetwork = async () => { discoveries++; return 'api-only'; };
    const grant = await requestAgentRunMcpGrant('run-1', phase, { environment, fetchImpl, resolveNetwork });
    assert.equal(grant.url, environment.PROPR_AGENT_MCP_URL);
    assert.equal(grant.network, null);
    assert.equal(discoveries, 0);
    const pinned = await requestAgentRunMcpGrant('run-1', phase, {
      environment: { ...environment, PROPR_AGENT_DOCKER_NETWORK: 'api-only' }, fetchImpl, resolveNetwork,
    });
    assert.equal(pinned.network, 'api-only');
    assert.equal(discoveries, 1);
  });
}
