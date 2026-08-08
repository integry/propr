import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { proprTunnelEndpoints } from '../packages/shared/src/proprServiceUrls.js';
import { parseSlashCommand } from '../packages/core/src/webhook/slashCommandParser.js';
import { extractKeywords } from '../packages/core/src/services/relevance/keywordExtractor.js';
import { truncateToSentences } from '../packages/core/src/services/planning/sentenceTruncation.js';
import { sanitizeDockerNamePart } from '../packages/core/src/agents/impl/utils/vibeAgentHelpers.js';
import { inferOpenCodeDataPath } from '../packages/core/src/agents/impl/openCodeUtils.js';
import { trimPathSlashes } from '../packages/api/routes/summaryPathUtils.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

const REPETITIONS = 100_000;

after(closeConnection);

test('slash commands handle long whitespace runs without ambiguous matching', () => {
  const parsed = parseSlashCommand(`/fix${'\t'.repeat(REPETITIONS)}safe`);
  assert.deepEqual(parsed, { command: 'fix', args: ['safe'], instructions: '' });
});

test('keyword extraction handles long delimiter and path-like runs', () => {
  const keywords = extractKeywords(`${'!'.repeat(REPETITIONS)} src/auth/login.ts ${'-'.repeat(REPETITIONS)}`);
  assert.ok(keywords.includes('src/auth/login.ts'));
  assert.ok(keywords.length <= 256);
  assert.ok(keywords.every(keyword => keyword.length <= 512));
});

test('keyword extraction preserves paths with boundary slashes', () => {
  const keywords = extractKeywords('Inspect /src/auth/login.ts and src/auth/');
  assert.ok(keywords.includes('src/auth/login.ts'));
  assert.ok(keywords.includes('src/auth'));
});

test('sentence truncation consumes long punctuation runs in one pass', () => {
  const firstSentence = `Ready${'!'.repeat(REPETITIONS)}`;
  assert.equal(truncateToSentences(`${firstSentence} Next? Ignored.`), `${firstSentence} Next?`);
});

test('sentence truncation preserves punctuation-only separator matches', () => {
  assert.equal(truncateToSentences('Hello. ... World?'), 'Hello. ...');
});

test('Docker-name sanitization trims long invalid boundary runs', () => {
  const value = `${'-'.repeat(REPETITIONS)}safe_name${'.'.repeat(REPETITIONS)}`;
  assert.equal(sanitizeDockerNamePart(value, 'fallback'), 'safe_name');
});

test('URL and filesystem boundary normalization handle long slash runs', () => {
  const slashes = '/'.repeat(REPETITIONS);
  assert.deepEqual(proprTunnelEndpoints(`https://example.test${slashes}`), {
    apiStatus: 'https://example.test/api/status',
    socketIo: 'https://example.test/socket.io/',
    root: 'https://example.test/',
  });
  assert.equal(
    inferOpenCodeDataPath(`/home/node/.config/opencode${slashes}`),
    '/home/node/.local/share/opencode',
  );
  assert.equal(trimPathSlashes(`${slashes}src/file.ts${slashes}`), 'src/file.ts');
});
