import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const compose = readFileSync(new URL('../docker-compose.prod.yml', import.meta.url), 'utf8');

/** The names of every top-level service in the production Compose file. */
function serviceNames() {
  const services = compose.slice(compose.indexOf('\nservices:\n'));
  return [...services.matchAll(/\n  ([a-z][\w-]*):\n/g)].map(match => match[1]);
}

/** The text of one top-level service block in the production Compose file. */
function serviceBlock(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} service must exist`);
  const next = compose.slice(start + 1).search(/\n  [a-z][\w-]*:\n|\n[a-z]/);
  return next < 0 ? compose.slice(start) : compose.slice(start, start + 1 + next);
}

/** Services whose process starts agent containers: the worker, and an indexing worker if the file defines one. */
function agentRunningServices() {
  const services = serviceNames().filter(name => /worker\.js|indexing_worker\.js|indexing-worker/.test(serviceBlock(name)));
  assert.ok(services.includes('worker'), 'the worker service starts agent containers');
  return services;
}

test('production Compose forwards the agent network policy to the worker and the API', () => {
  const expectedDefaults = { AGENT_NETWORK_MODE: 'open', AGENT_NETWORK_MODE_ENFORCED: 'false', AGENT_NETWORK_ALLOW: '', AGENT_NETWORK_IGNORE_REPOSITORY_ALLOW: 'false' };
  for (const service of ['worker', 'api']) {
    const block = serviceBlock(service);
    for (const [name, defaultValue] of Object.entries(expectedDefaults)) {
      const forwarding = `${name}: ` + '${' + `${name}:-${defaultValue}}`;
      assert.ok(block.includes(forwarding), `${service} must forward ${name} with its documented default`);
    }
  }
});

test('every production Compose service that starts agent containers shares the egress socket directory with the Docker host', () => {
  // A restricted-mode container of a service without the mount would mount an empty host directory, find no
  // socket, and run with no network at all: failing closed, but silently from the operator's view.
  const socketDir = '${HOST_PROPR_EGRESS_SOCKET_DIR:-/tmp/propr-egress}';
  for (const service of agentRunningServices()) {
    const block = serviceBlock(service);
    assert.ok(block.includes('PROPR_EGRESS_SOCKET_DIR: /tmp/propr-egress'), `${service} must set PROPR_EGRESS_SOCKET_DIR`);
    assert.ok(block.includes(`HOST_PROPR_EGRESS_SOCKET_DIR: ${socketDir}`), `${service} must forward HOST_PROPR_EGRESS_SOCKET_DIR`);
    assert.ok(block.includes(`- ${socketDir}:/tmp/propr-egress`), `${service} must bind-mount the egress socket directory from the host`);
  }
  // The legacy production file does not start the indexing worker; if one is added, it is held to the same contract above.
  const indexing = serviceNames().filter(name => /indexing/.test(name));
  for (const service of indexing) assert.ok(agentRunningServices().includes(service), `${service} runs summarization containers`);
});
