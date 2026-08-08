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

test('slash commands reject embedded line terminators but accept trailing ones', () => {
  for (const separator of ['\r', '\u2028', '\u2029']) {
    assert.equal(parseSlashCommand(`/fix one${separator}two`), null);
    assert.deepEqual(parseSlashCommand(`/fix one${separator}`), {
      command: 'fix',
      args: ['one'],
      instructions: '',
    });
  }
});

test('keyword extraction handles long delimiter and path-like runs', () => {
  const keywords = extractKeywords(`${'!'.repeat(REPETITIONS)} src/auth/login.ts ${'-'.repeat(REPETITIONS)}`);
  assert.ok(keywords.includes('src/auth/login.ts'));
});

test('keyword extraction preserves paths with boundary slashes', () => {
  const keywords = extractKeywords('Inspect /src/auth/login.ts and src/auth/');
  assert.ok(keywords.includes('src/auth/login.ts'));
  assert.ok(keywords.includes('src/auth'));
});

test('keyword extraction preserves dotted filename word boundaries', () => {
  for (const [prompt, expected] of [
    ['.eslintrc.json', 'eslintrc.json'],
    ['-package.json', 'package.json'],
    ['package.json-', 'package.json'],
    ['check...package.json', 'package.json'],
    ['check...nested.ts', 'nested.ts'],
    ['package.json...next', 'package.json'],
  ]) {
    assert.equal(extractKeywords(prompt)[0], expected);
  }
});

test('keyword extraction does not silently cap input or results', () => {
  const lateKeyword = `${'padding '.repeat(30_000)}tail-file.ts`;
  assert.ok(extractKeywords(lateKeyword).includes('tail-file.ts'));

  const manyKeywords = Array.from({ length: 300 }, (_, index) => `term${index}`).join(' ');
  assert.ok(extractKeywords(manyKeywords).includes('term299'));

  const longKeyword = `x${'y'.repeat(512)}`;
  assert.ok(extractKeywords(longKeyword).includes(longKeyword));
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
