import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dockerfile = readFileSync(new URL('../Dockerfile.agent', import.meta.url), 'utf8');

test('Antigravity agent build uses a versioned artifact with a pinned checksum', () => {
  assert.match(dockerfile, /ARG ANTIGRAVITY_CLI_VERSION=\d+\.\d+\.\d+/);
  assert.doesNotMatch(dockerfile, /ANTIGRAVITY_CLI_VERSION=latest/);
  assert.match(dockerfile, /ARG ANTIGRAVITY_CLI_SHA512=[a-f0-9]{128}/);
  assert.match(dockerfile, /antigravity-cli\/\$\{ANTIGRAVITY_CLI_VERSION\}-\$\{ANTIGRAVITY_CLI_RELEASE_ID\}/);
});

test('Antigravity checksum verification happens before archive extraction', () => {
  const checksumIndex = dockerfile.indexOf('sha512sum -c -');
  const extractionIndex = dockerfile.indexOf('tar -xzf');
  assert.ok(checksumIndex > 0);
  assert.ok(extractionIndex > checksumIndex);
});

test('agent build never downloads and executes the mutable installer script', () => {
  assert.doesNotMatch(dockerfile, /antigravity\.google\/cli\/install\.sh/);
  assert.doesNotMatch(dockerfile, /antigravity-install\.sh/);
});
