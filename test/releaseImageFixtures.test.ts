import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateSessionSecret } from '../packages/shared/src/sessionSecret.js';

const smokeScript = readFileSync('scripts/smoke-test-images.sh', 'utf8');
const integrationScript = readFileSync('scripts/integration-test-images.sh', 'utf8');

function literalAssignment(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}=([^\\r\\n]+)$`, 'm'));
  assert.ok(match, `${name} must be present in the release fixture`);
  return match[1];
}

test('release image smoke fixture satisfies production startup requirements', () => {
  assert.equal(validateSessionSecret(literalAssignment(smokeScript, 'SESSION_SECRET')), undefined);
  assert.equal(literalAssignment(smokeScript, 'PROPR_CONTAINERIZED'), '1');
  assert.match(literalAssignment(smokeScript, 'PROPR_ADMIN_USERS'), /^[a-z0-9-]+$/);
});

test('release image integration fixture satisfies production startup requirements', () => {
  assert.equal(validateSessionSecret(literalAssignment(integrationScript, 'SESSION_SECRET')), undefined);
  assert.equal(literalAssignment(integrationScript, 'PROPR_CONTAINERIZED'), '1');
  assert.match(literalAssignment(integrationScript, 'PROPR_ADMIN_USERS'), /PROPR_E2E_ADMIN_USER/);
});

test('unauthenticated image smoke probes only public API routes', () => {
  assert.match(smokeScript, /\$expected_origin\/api\/compatibility/);
  assert.doesNotMatch(smokeScript, /\$expected_origin\/api\/status/);
  assert.match(smokeScript, /\\"version\\":\\"\$\{EXPECTED_VERSION\}\\"/);
});
