import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

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

test('a containerized worker hands agent containers its own Compose network', async () => {
  const { calls, inspect } = inspector('bridge\npropr_propr-net\n');
  const network = await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect });
  assert.equal(network, 'propr_propr-net');
  assert.deepEqual(calls, ['abc123']);
});

test('PROPR_AGENT_DOCKER_NETWORK pins the network without inspecting anything', async () => {
  const { calls, inspect } = inspector('propr_propr-net\n');
  const network = await resolveMcpContainerNetwork({ environment: { PROPR_AGENT_DOCKER_NETWORK: ' ops-net ', PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect });
  assert.equal(network, 'ops-net');
  assert.deepEqual(calls, []);
});

test('an invalid pinned name, a native worker, or a failed inspect keep the default bridge', async () => {
  const { inspect } = inspector('propr_propr-net\n');
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_AGENT_DOCKER_NETWORK: 'bad net; rm -rf /' }, inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '0', HOSTNAME: 'abc123' }, inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1' }, inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect: inspector('', 1).inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect: inspector('bridge\n').inspect }), null);
  assert.equal(await resolveMcpContainerNetwork({ environment: { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' }, inspect: async () => { throw new Error('docker down'); } }), null);
});

test('the worker resolves its network once per process', async () => {
  const { calls, inspect } = inspector('propr_propr-net\n');
  const environment = { PROPR_CONTAINERIZED: '1', HOSTNAME: 'abc123' };
  assert.equal(await mcpContainerNetwork({ environment, inspect }), 'propr_propr-net');
  assert.equal(await mcpContainerNetwork({ environment, inspect }), 'propr_propr-net');
  assert.deepEqual(calls, ['abc123']);
});
