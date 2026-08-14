import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateSessionSecret } from '../packages/shared/src/sessionSecret.js';

const smokeScript = readFileSync('scripts/smoke-test-images.sh', 'utf8');
const integrationScript = readFileSync('scripts/integration-test-images.sh', 'utf8');
const antigravityVerificationScript = readFileSync('scripts/verify-antigravity-image.sh', 'utf8');
const releaseImageWorkflow = readFileSync('.github/workflows/docker-images.yml', 'utf8');
const antigravity113VerifierFixturePath = new URL('./fixtures/antigravity-verifier-pinned-1.1.13.json', import.meta.url);
const sqliteStartupScript = readFileSync('scripts/smoke-test-sqlite-startup.sh', 'utf8');

function literalAssignment(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}=([^\\r\\n]+)$`, 'm'));
  assert.ok(match, `${name} must be present in the release fixture`);
  return match[1];
}

function runAntigravityVerification(
  initModelEvidence = 'pinned-1.1.13-canonical',
  modelsEvidence = 'mapped',
  conversationEvidence = 'consistent',
) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'propr-antigravity-script-test.'));
  const binDirectory = join(fixtureRoot, 'bin');
  const configDirectory = join(fixtureRoot, 'config');
  mkdirSync(binDirectory);
  mkdirSync(configDirectory);

  const fakeDockerPath = join(binDirectory, 'docker');
  writeFileSync(
    fakeDockerPath,
    `#!/usr/bin/env node
const { readFileSync } = require('node:fs');

const args = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(process.env.ANTIGRAVITY_VERIFIER_FIXTURE, 'utf8'));
if (args[0] === 'image' && args[1] === 'inspect') process.exit(0);
if (args.at(-1) === '--version') {
  process.stdout.write(\`\${fixture.cliVersion}\\n\`);
  process.exit(0);
}
if (args.at(-1) === 'models') {
  const mappings = fixture.models.map(({ id, displayName }) => [id, displayName]);
  const lines = process.env.FAKE_MODELS_EVIDENCE === 'unmapped'
    ? [...mappings.map(([id]) => id), ...mappings.map(([, name]) => name)]
    : mappings.map(([id, name]) => \`\${id} — \${name}\`);
  process.stdout.write(\`\${lines.join('\\n')}\\n\`);
  process.exit(0);
}

const modelIndex = args.indexOf('--model');
if (modelIndex === -1) throw new Error(\`unexpected docker arguments: \${args.join(' ')}\`);
const modelId = args[modelIndex + 1];
const prompt = readFileSync(0, 'utf8');
if (prompt !== 'Reply with exactly STREAM_OK. Do not use tools.') {
  throw new Error(\`unexpected stdin prompt: \${JSON.stringify(prompt)}\`);
}

const modelFixture = fixture.models.find(candidate => candidate.id === modelId);
if (!modelFixture) throw new Error(\`missing fixture for model: \${modelId}\`);
const events = JSON.parse(JSON.stringify(modelFixture.stream));
const init = events.find(event => event.event === 'init');
if (!init) throw new Error(\`missing init fixture for model: \${modelId}\`);
const evidence = process.env.FAKE_INIT_MODEL_EVIDENCE;
if (evidence === 'missing') delete init.init.model;
else if (evidence === 'different-tier') {
  init.init.model = fixture.models.find(candidate => candidate.id !== modelId).id;
} else if (evidence === 'alias') init.init.model = 'flash37-high';
else if (evidence === 'display-name') init.init.model = modelFixture.displayName;
if (process.env.FAKE_CONVERSATION_EVIDENCE === 'mixed') {
  const stepUpdate = events.find(event => event.event === 'step_update');
  const result = events.find(event => event.event === 'result');
  if (!stepUpdate || !result) throw new Error(\`missing correlation fixture for model: \${modelId}\`);
  stepUpdate.step_update.conversation_id = \`\${init.conversation_id}-step\`;
  result.result.conversation_id = \`\${init.conversation_id}-result\`;
}
process.stdout.write(\`\${events.map(JSON.stringify).join('\\n')}\\n\`);
`,
  );
  chmodSync(fakeDockerPath, 0o755);

  try {
    return spawnSync('bash', ['scripts/verify-antigravity-image.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_TAG: 'fake-antigravity-agent',
        ANTIGRAVITY_CONFIG_PATH: configDirectory,
        ANTIGRAVITY_VERIFIER_FIXTURE: antigravity113VerifierFixturePath.pathname,
        FAKE_INIT_MODEL_EVIDENCE: initModelEvidence,
        FAKE_MODELS_EVIDENCE: modelsEvidence,
        FAKE_CONVERSATION_EVIDENCE: conversationEvidence,
        PATH: `${binDirectory}:${process.env.PATH}`,
      },
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
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

test('direct-webhook smoke fixtures use the canonical webhook secret variable', () => {
  const fixtures = [
    ['image smoke', smokeScript],
    ['image integration', integrationScript],
    ['SQLite startup smoke', sqliteStartupScript],
  ] as const;

  assert.equal(literalAssignment(sqliteStartupScript, 'GITHUB_EVENT_INTAKE_MODE'), 'direct_webhook');

  for (const [name, source] of fixtures) {
    if (!/^GITHUB_EVENT_INTAKE_MODE=direct_webhook$/m.test(source)) continue;

    assert.match(source, /^GH_WEBHOOK_SECRET=[^\r\n]+$/m, `${name} must set GH_WEBHOOK_SECRET`);
    assert.doesNotMatch(
      source,
      /^GITHUB_WEBHOOK_SECRET=/m,
      `${name} must not rely on the legacy GITHUB_WEBHOOK_SECRET name`,
    );
  }
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
  assert.match(antigravityVerificationScript, /^set -euo pipefail$/m);
  assert.match(antigravityVerificationScript, /run_agy models/);
  assert.match(antigravityVerificationScript, /docker run --rm -i \\/);
  assert.match(
    antigravityVerificationScript,
    /printf '%s' 'Reply with exactly STREAM_OK\. Do not use tools\.' \|\n\s+run_agy \\\n\s+--dangerously-skip-permissions \\\n\s+--print-timeout 5m \\\n\s+--output-format stream-json \\\n\s+--model "\$model_id"/,
  );
  assert.doesNotMatch(antigravityVerificationScript, /(?:^|\s)--print(?:\s|\\)/);
  assert.doesNotMatch(antigravityVerificationScript, /--model "\$model_id" \\/);
  assert.match(antigravityVerificationScript, /event\?\.event === "init"/);
  assert.match(antigravityVerificationScript, /event\.init\?\.model/);
  assert.match(antigravityVerificationScript, /event\?\.type === "init"/);
  assert.match(antigravityVerificationScript, /EXPECTED_MODEL_ID="\$model_id"/);
  assert.match(antigravityVerificationScript, /reportedModel !== process\.env\.EXPECTED_MODEL_ID/);
  assert.match(antigravityVerificationScript, /terminalStatus\.toUpperCase\(\) !== "SUCCESS"/);
  assert.match(antigravityVerificationScript, /EXPECTED_RESPONSE=\$'STREAM_OK\\n'/);
  assert.match(antigravityVerificationScript, /response !== process\.env\.EXPECTED_RESPONSE/);
  assert.match(antigravityVerificationScript, /reported_model.*model_id/s);
  for (const id of ['gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low']) {
    assert.match(antigravityVerificationScript, new RegExp(id));
  }
  assert.match(integrationScript, /\.\/scripts\/verify-antigravity-image\.sh/);
});

test('release publication requires authenticated Antigravity verification of the freshly built agent image', () => {
  assert.match(
    releaseImageWorkflow,
    /Build Docker Hub-tagged images[\s\S]+Smoke test Docker Hub images[\s\S]+Verify authenticated Antigravity models from packaged agent image[\s\S]+AGENT_TAG: \$\{\{ env\.DOCKERHUB_NS \}\}\/agent:\$\{\{ steps\.version\.outputs\.version \}\}[\s\S]+\.\/scripts\/verify-antigravity-image\.sh[\s\S]+Stage, preflight, and publish smoke-tested images/,
  );
});

test('authenticated image verifier accepts pinned 1.1.13 canonical init.model envelopes', () => {
  const result = runAntigravityVerification();

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  for (const id of ['gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low']) {
    assert.match(result.stdout, new RegExp(`${id} returned exact sentinel with SUCCESS and reported ${id}`));
  }
});

test('authenticated image verifier rejects missing, alias, display-name, and other-tier init.model evidence', () => {
  for (const evidence of ['missing', 'different-tier', 'alias', 'display-name']) {
    const result = runAntigravityVerification(evidence);
    assert.notEqual(result.status, 0, `${evidence} evidence must not pass`);
    assert.match(result.stderr, /expected init model "gemini-3\.7-flash-high", got/);
  }
});

test('authenticated image verifier rejects mixed-conversation stream evidence', () => {
  const result = runAntigravityVerification('pinned-1.1.13-canonical', 'mapped', 'mixed');

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /step_update envelope expected conversation_id "fixture-conversation-high", got "fixture-conversation-high-step"/,
  );
});

test('authenticated image verifier requires each discovered ID and display name on the same mapping', () => {
  const result = runAntigravityVerification('pinned-1.1.13-canonical', 'unmapped');

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Antigravity CLI did not advertise gemini-3\.7-flash-high as Gemini 3\.7 Flash \(High\)/,
  );
});
