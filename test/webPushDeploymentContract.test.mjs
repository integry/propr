import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readRepositoryFile = relativePath => readFileSync(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
);

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
