import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readRepositoryFile = relativePath => readFileSync(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
);

test('legacy production Compose forwards every documented Web Push tuning variable', () => {
  const compose = readRepositoryFile('docker-compose.prod.yml');
  const expectedDefaults = {
    WEB_PUSH_DISPATCH_INTERVAL_MS: '5000',
    WEB_PUSH_DISPATCH_BATCH_SIZE: '20',
    WEB_PUSH_DELIVERY_LEASE_MS: '60000',
    WEB_PUSH_REQUEST_TIMEOUT_MS: '15000',
    WEB_PUSH_TTL_SECONDS: '300',
  };

  for (const [name, defaultValue] of Object.entries(expectedDefaults)) {
    const forwarding = `${name}: ` + '${' + `${name}:-${defaultValue}}`;
    assert.ok(compose.includes(forwarding), `${name} must be forwarded with its documented default`);
  }
});

test('the reverse-proxy documentation includes every explicitly precached logo', () => {
  const worker = readRepositoryFile('propr-ui/public/service-worker.js');
  const pwaGuide = readRepositoryFile('docs/docs/operations/pwa-web-push.md');
  const deploymentGuide = readRepositoryFile('docs/docs/operations/deployment.md');

  for (const path of ['/logo.png', '/logo-loading.png', '/media/logo-and-name.png']) {
    assert.ok(worker.includes(`'${path}'`), `${path} must remain an explicit precache URL`);
    assert.ok(pwaGuide.includes(`\`${path}\``), `${path} must be in the proxy contract`);
    assert.ok(deploymentGuide.includes(`\`${path}\``), `${path} must be in the deployment summary`);
  }
});
