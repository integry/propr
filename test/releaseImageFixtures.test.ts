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

function literalAssignment(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}=([^\\r\\n]+)$`, 'm'));
  assert.ok(match, `${name} must be present in the release fixture`);
  return match[1];
}

function runAntigravityVerification(
  initModelEvidence = 'canonical',
  modelsEvidence = 'mapped',
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
if (args[0] === 'image' && args[1] === 'inspect') process.exit(0);
if (args.at(-1) === '--version') {
  process.stdout.write('1.1.13\\n');
  process.exit(0);
}
if (args.at(-1) === 'models') {
  const mappings = [
    ['gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'],
    ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'],
    ['gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)'],
  ];
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

const displayNames = {
  'gemini-3.7-flash-high': 'Gemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium': 'Gemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low': 'Gemini 3.7 Flash (Low)',
};
const evidence = process.env.FAKE_INIT_MODEL_EVIDENCE;
const reportedModel = evidence === 'display-name'
  ? displayNames[modelId]
  : evidence === 'different-tier'
    ? 'gemini-3.7-flash-medium'
    : evidence === 'alias'
      ? 'flash37-high'
      : modelId;
const init = {
  event: 'init',
  conversation_id: 'fixture-conversation',
  init: { cwd: '/tmp', tools: [] },
};
if (evidence !== 'missing') init.init.model = reportedModel;
const events = [
  init,
  {
    event: 'step_update',
    step_update: {
      conversation_id: 'fixture-conversation',
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'STREAM_OK\\n',
    },
  },
  {
    event: 'result',
    result: {
      conversation_id: 'fixture-conversation',
      status: 'SUCCESS',
      response: 'STREAM_OK\\n',
    },
  },
];
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
        FAKE_INIT_MODEL_EVIDENCE: initModelEvidence,
        FAKE_MODELS_EVIDENCE: modelsEvidence,
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

test('authenticated image verifier accepts realistic canonical init.model envelopes', () => {
  const result = runAntigravityVerification();

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  for (const id of ['gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low']) {
    assert.match(result.stdout, new RegExp(`${id} returned exact sentinel with SUCCESS and reported ${id}`));
  }
});

test('authenticated image verifier rejects non-canonical init.model evidence', () => {
  for (const evidence of ['missing', 'different-tier', 'alias', 'display-name']) {
    const result = runAntigravityVerification(evidence);
    assert.notEqual(result.status, 0, `${evidence} evidence must not pass`);
    assert.match(result.stderr, /expected init model "gemini-3\.7-flash-high", got/);
  }
});

test('authenticated image verifier requires each discovered ID and display name on the same mapping', () => {
  const result = runAntigravityVerification('canonical', 'unmapped');

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Antigravity CLI did not advertise gemini-3\.7-flash-high as Gemini 3\.7 Flash \(High\)/,
  );
});
