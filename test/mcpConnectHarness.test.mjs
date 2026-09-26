import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { resolveRoutingRevision } from '../scripts/test-mcp-connect.mjs';

test('paired harness accepts exact commits and rejects revision expressions and non-commit objects', () => {
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const repository = git(['rev-parse', '--show-toplevel']);
  const head = git(['rev-parse', 'HEAD']);
  // Also works in core CI's shallow checkout; no parent history is required.
  assert.equal(resolveRoutingRevision(repository, head), head, 'an explicit candidate must override the default');
  for (const revision of ['HEAD', head.slice(0, 12), `${head}^`, `${head}\n`, '--all', '$(touch /tmp/should-not-exist)', '']) {
    assert.throws(() => resolveRoutingRevision(repository, revision), /full lowercase 40-character commit SHA/);
  }
  assert.throws(() => resolveRoutingRevision(repository, '0'.repeat(40)));
  assert.throws(() => resolveRoutingRevision(repository, git(['rev-parse', 'HEAD:package.json'])));
  assert.throws(() => resolveRoutingRevision(undefined, head), /MCP_ROUTING_REPOSITORY/);
});
