import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateSessionSecret } from '../packages/shared/src/sessionSecret.js';

const smokeScript = readFileSync('scripts/smoke-test-images.sh', 'utf8');
const integrationScript = readFileSync('scripts/integration-test-images.sh', 'utf8');
const antigravityVerificationScript = readFileSync('scripts/verify-antigravity-image.sh', 'utf8');

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

test('authenticated image integration verifies every Gemini 3.7 Flash tier without silent fallback', () => {
  for (const tier of ['High', 'Medium', 'Low']) {
    assert.match(antigravityVerificationScript, new RegExp(`Gemini 3\\.7 Flash \\(${tier}\\)`));
  }
  assert.match(antigravityVerificationScript, /run_agy models/);
  assert.match(
    antigravityVerificationScript,
    /run_agy \\\n\s+--dangerously-skip-permissions \\\n\s+--print \\\n[\s\S]*?--output-format stream-json/,
  );
  assert.match(antigravityVerificationScript, /event\?\.event === "init"/);
  assert.match(antigravityVerificationScript, /event\.init\?\.model/);
  assert.match(antigravityVerificationScript, /event\?\.type === "init"/);
  assert.match(antigravityVerificationScript, /reportedModel !== process\.env\.EXPECTED_MODEL/);
  assert.match(antigravityVerificationScript, /terminalStatus\.toUpperCase\(\) !== "SUCCESS"/);
  assert.match(antigravityVerificationScript, /EXPECTED_RESPONSE=\$'STREAM_OK\\n'/);
  assert.match(antigravityVerificationScript, /response !== process\.env\.EXPECTED_RESPONSE/);
  assert.match(antigravityVerificationScript, /reported_model.*display_name/s);
  for (const id of ['gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low']) {
    assert.match(antigravityVerificationScript, new RegExp(id));
  }
  assert.match(integrationScript, /\.\/scripts\/verify-antigravity-image\.sh/);
});
