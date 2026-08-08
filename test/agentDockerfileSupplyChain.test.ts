import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dockerfile = readFileSync(new URL('../Dockerfile.agent', import.meta.url), 'utf8');
const buildScript = readFileSync(new URL('../scripts/build-images.sh', import.meta.url), 'utf8');

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

test('Antigravity artifact download retries and uses a pinned-path fallback', () => {
  assert.match(dockerfile, /--retry 5 --retry-delay 2 --retry-max-time 180 --retry-all-errors/);
  assert.match(dockerfile, /storage\.googleapis\.com\/download\/storage\/v1\/b\/antigravity-public\/o\/antigravity-cli%2F/);
  assert.match(dockerfile, /for candidate_url in "\$source_url" "\$fallback_url"/);
  assert.match(dockerfile, /printf '%s\\n' "\$downloaded_from" > \/home\/node\/\.local\/share\/propr\/antigravity-cli\.source/);
});

test('agent build never downloads and executes the mutable installer script', () => {
  assert.doesNotMatch(dockerfile, /antigravity\.google\/cli\/install\.sh/);
  assert.doesNotMatch(dockerfile, /antigravity-install\.sh/);
  assert.doesNotMatch(dockerfile, /\bagy install\b/);
});

test('the image build script uses the same pinned Antigravity version', () => {
  const dockerVersion = dockerfile.match(/ARG ANTIGRAVITY_CLI_VERSION=(\d+\.\d+\.\d+)/)?.[1];
  const scriptVersion = buildScript.match(/ANTIGRAVITY_CLI_VERSION="\$\{ANTIGRAVITY_CLI_VERSION:-(\d+\.\d+\.\d+)\}"/)?.[1];
  assert.ok(dockerVersion);
  assert.equal(scriptVersion, dockerVersion);
});
