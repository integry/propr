import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeNpmPackageName } from '../packages/core/src/agents/version/npmClient.js';
import { shortHash } from '../packages/shared/src/labelUtils.js';

test('npm registry package paths encode scoped names and reject ambiguous input', () => {
  assert.equal(encodeNpmPackageName('@anthropic-ai/claude-code'), '@anthropic-ai%2Fclaude-code');
  assert.equal(encodeNpmPackageName('opencode-ai'), 'opencode-ai');
  assert.throws(() => encodeNpmPackageName('@scope/name@other'), /Invalid npm package name/);
  assert.throws(() => encodeNpmPackageName('../package'), /Invalid npm package name/);
});

test('label hashing rejects unbounded model identifiers', () => {
  assert.equal(shortHash('model-id'), shortHash('model-id'));
  assert.equal(typeof shortHash('x'.repeat(4096)), 'string');
  assert.throws(() => shortHash('x'.repeat(4097)), /exceeds 4096 characters/);
});

test('agent transcript and epic branch suffixes use cryptographic unbiased randomness', () => {
  const antigravityAgent = readFileSync(
    new URL('../packages/core/src/agents/impl/AntigravityAgent.ts', import.meta.url),
    'utf8',
  );
  const epicService = readFileSync(
    new URL('../packages/core/src/services/epicPRService.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(antigravityAgent, /Math\.random/);
  assert.match(antigravityAgent, /randomBytes\(8\)/);
  assert.match(epicService, /crypto\.randomInt\(chars\.length\)/);
  assert.doesNotMatch(epicService, /randomBytes\[i\]\s*%\s*chars\.length/);
});
