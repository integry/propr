import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import { parse } from 'yaml';

const { mcpContainerNetwork, resetMcpContainerNetworkCache, resolveMcpContainerNetwork } = await import('../src/jobs/agentRuns/mcpNetwork.ts');

// Importing @propr/core opens the shared database connection.
after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

beforeEach(() => resetMcpContainerNetworkCache());

function inspector(stdout: string, exitCode = 0) {
  const calls: string[] = [];
  const inspect = async (containerId: string) => { calls.push(containerId); return { exitCode, stdout, stderr: exitCode ? 'no such object' : '' }; };
  return { calls, inspect };
}

test('a containerized worker selects the API-only network from its Compose project', async () => {
  const { calls, inspect } = inspector('propr\n');
  const network = await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect });
  assert.equal(network, 'propr_propr-agent-mcp');
  assert.deepEqual(calls, ['abc123']);
});

test('PROPR_AGENT_DOCKER_NETWORK pins the network without inspecting anything', async () => {
  const { calls, inspect } = inspector('propr\n');
  const network = await resolveMcpContainerNetwork({ environment: { PROPR_AGENT_DOCKER_NETWORK: ' ops-net ', PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect });
  assert.equal(network, 'ops-net');
  assert.deepEqual(calls, []);
});

test('an invalid pinned name, a native worker, or a failed inspect keep the default bridge', async () => {
  const { inspect } = inspector('propr\n');
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_AGENT_DOCKER_NETWORK: 'bad net; rm -rf /' }, inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '0', HOSTNAME: 'abc123' }, inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1' }, inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect: inspector('', 1).inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect: inspector('<no value>\n').inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect: async () => { throw new Error('docker down'); } }), null);
});

test('the worker resolves its Compose project once per process', async () => {
  const { calls, inspect } = inspector('propr\n');
  const environment = { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' };
  assert.equal(await mcpContainerNetwork({ environment, inspect }), 'propr_propr-agent-mcp');
  assert.equal(await mcpContainerNetwork({ environment, inspect }), 'propr_propr-agent-mcp');
  assert.deepEqual(calls, ['abc123']);
});

test('missing or malformed Compose labels never select a shared service network', async () => {
  for (const label of ['', '<no value>', 'bad project', 'propr\nother', 'x'.repeat(128)]) {
    assert.equal(await resolveMcpContainerNetwork({
      environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect: inspector(label).inspect,
    }), null);
  }
});

test('explicit endpoints stay on bridge and explicit networks override cached discovery', async () => {
  const { calls, inspect } = inspector('propr\n');
  const environment = { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' };
  assert.equal(await mcpContainerNetwork({ environment, inspect }), 'propr_propr-agent-mcp');
  const custom = { ...environment, PROPR_AGENT_MCP_URL: 'https://mcp.example/api/mcp' };
  assert.equal(await resolveMcpContainerNetwork({ environment: custom, inspect }), null);
  assert.equal(await mcpContainerNetwork({ environment: custom, inspect }), null);
  assert.equal(await mcpContainerNetwork({ environment: { ...custom, PROPR_AGENT_DOCKER_NETWORK: 'api-only' }, inspect }), 'api-only');
  assert.deepEqual(calls, ['abc123']);
});

test('the bundled MCP network has only the API and is separate from internal services', async () => {
  const compose = parse(readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8'));
  const network = await resolveMcpContainerNetwork({
    environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect: inspector('custom-project').inspect,
  });
  const key = network!.slice('custom-project_'.length);
  assert.equal(compose.networks[key].driver, 'bridge');
  const members = Object.entries(compose.services)
    .filter(([, service]) => (service as { networks: string[] }).networks.includes(key))
    .map(([name]) => name);
  assert.deepEqual(members, ['api']);
  assert.ok(compose.services.api.networks.includes('propr-net'));
  assert.deepEqual(compose.services.redis.networks, ['propr-net']);
});

test('an in-flight discovery cannot attach an explicit endpoint to its network', async () => {
  let finish!: (result: { exitCode: number; stdout: string; stderr: string }) => void;
  const inspection = new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => { finish = resolve; });
  const environment = { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' };
  const pending = mcpContainerNetwork({ environment, inspect: () => inspection });
  assert.equal(await mcpContainerNetwork({ environment: { ...environment, PROPR_AGENT_MCP_URL: 'https://mcp.example/api/mcp' } }), null);
  finish({ exitCode: 0, stdout: 'propr', stderr: '' });
  assert.equal(await pending, 'propr_propr-agent-mcp');
});
