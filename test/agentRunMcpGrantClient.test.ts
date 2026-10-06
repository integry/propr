import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { signAgentRunGrantRequest } from '@propr/core';

const { agentContainerMcpUrl, requestAgentRunMcpGrant, revokeAgentRunMcpGrant, AgentRunMcpGrantError } = await import('../src/jobs/agentRuns/mcpGrantClient.ts');

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
  const grant = await requestAgentRunMcpGrant('run/1', 'action', { environment, fetchImpl, now: () => NOW });
  assert.deepEqual(grant, { grantId: 'g-1', phase: 'action', url: 'http://api:4000/api/mcp', token: 'propr_mcp_x', expiresAt: NOW + 1 });
  assert.equal(calls[0].url, 'http://propr-api:4000/api/internal/agent-runs/run%2F1/mcp-grants');
  assert.deepEqual(calls[0].body, { phase: 'action', ts: NOW, signature: signAgentRunGrantRequest('secret', 'run/1', 'action', NOW) });

  await revokeAgentRunMcpGrant('run/1', grant, { environment, fetchImpl, now: () => NOW });
  assert.equal(calls[1].url, 'http://propr-api:4000/api/internal/agent-runs/run%2F1/mcp-grants/revoke');
  assert.deepEqual(calls[1].body, { phase: 'action', grantId: 'g-1', ts: NOW, signature: signAgentRunGrantRequest('secret', 'run/1', 'action', NOW) });
});

test('API rejections and a missing secret surface as typed errors without the token', async () => {
  const { fetchImpl } = recorder(() => Response.json({ error: 'INVALID_RUN_STATE', message: 'run is completed' }, { status: 409 }));
  await assert.rejects(requestAgentRunMcpGrant('run-1', 'report', { environment: { SYSTEM_TASK_SECRET: 's' }, fetchImpl }),
    (error: InstanceType<typeof AgentRunMcpGrantError>) => error.status === 409 && error.code === 'INVALID_RUN_STATE');
  await assert.rejects(requestAgentRunMcpGrant('run-1', 'report', { environment: {}, fetchImpl }), { code: 'SYSTEM_TASK_SECRET_MISSING' });
});
