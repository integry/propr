import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { latestTagFor, tagAgentLatest } from '../docker/launcher/orchestrator.mjs';

const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;

test('derives the local latest tag from tagged, digest-pinned, and registry-port references', () => {
  assert.equal(latestTagFor('propr/agent:0.9.0'), 'propr/agent:latest');
  assert.equal(latestTagFor(`propr/agent:${sha}@${digest}`), 'propr/agent:latest');
  assert.equal(latestTagFor(`propr/agent@${digest}`), 'propr/agent:latest');
  assert.equal(latestTagFor(`localhost:5000/propr/agent:${sha}@${digest}`), 'localhost:5000/propr/agent:latest');
  assert.equal(latestTagFor('localhost:5000/propr/agent'), null);
  assert.equal(latestTagFor('propr/agent'), null);
});

test('retags a digest-pinned preview agent as the latest image that workers run', () => {
  const binDir = mkdtempSync(join(tmpdir(), 'propr-fake-docker-tag-'));
  const log = join(binDir, 'docker.log');
  writeFileSync(join(binDir, 'docker'), `#!/bin/sh\necho "$*" >> "${log}"\nexit 0\n`);
  chmodSync(join(binDir, 'docker'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${previousPath}`;
  try {
    tagAgentLatest('agent', `propr/agent:${sha}@${digest}`);
    tagAgentLatest('app', `propr/app:${sha}@${digest}`);
    assert.equal(readFileSync(log, 'utf8'), `tag propr/agent:${sha}@${digest} propr/agent:latest\n`);
  } finally {
    process.env.PATH = previousPath;
    rmSync(binDir, { recursive: true, force: true });
  }
});
