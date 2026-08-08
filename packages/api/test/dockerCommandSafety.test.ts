import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isValidDockerContainerReference } from '../routes/dockerCommandSafety.js';

test('accepts Docker IDs and ProPR-generated container names', () => {
  assert.equal(isValidDockerContainerReference('18f3ec9e3ae1'), true);
  assert.equal(isValidDockerContainerReference('propr-agent-owner-repo-42'), true);
  assert.equal(isValidDockerContainerReference('worker_1.2'), true);
});

test('rejects container references that could be parsed as options or shell syntax', () => {
  for (const value of ['--help', 'name with spaces', 'name;id', '$(id)', 'name/child', '']) {
    assert.equal(isValidDockerContainerReference(value), false, value);
  }
});

test('production subprocess call sites do not invoke a command shell', () => {
  const productionFiles = [
    '../routes/dockerRoutes.ts',
    '../../core/src/claude/docker/dockerExecutor.ts',
    '../../core/src/git/worktreeOperations.ts',
    '../../core/src/agents/impl/CodexAgent.ts',
    '../../core/src/agents/impl/OpenCodeAgent.ts',
    '../../cli/src/auth/githubLogin.ts',
  ];

  for (const relativePath of productionFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bexecSync\s*\(/, relativePath);
  }
});
