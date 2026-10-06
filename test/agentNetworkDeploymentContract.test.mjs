import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const compose = readFileSync(new URL('../docker-compose.prod.yml', import.meta.url), 'utf8');

/** The text of one top-level service block in the production Compose file. */
function serviceBlock(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} service must exist`);
  const next = compose.slice(start + 1).search(/\n  [a-z][\w-]*:\n|\n[a-z]/);
  return next < 0 ? compose.slice(start) : compose.slice(start, start + 1 + next);
}

test('production Compose forwards the agent network policy to the worker and the API', () => {
  const expectedDefaults = { AGENT_NETWORK_MODE: 'open', AGENT_NETWORK_MODE_ENFORCED: 'false', AGENT_NETWORK_ALLOW: '' };
  for (const service of ['worker', 'api']) {
    const block = serviceBlock(service);
    for (const [name, defaultValue] of Object.entries(expectedDefaults)) {
      const forwarding = `${name}: ` + '${' + `${name}:-${defaultValue}}`;
      assert.ok(block.includes(forwarding), `${service} must forward ${name} with its documented default`);
    }
  }
});
