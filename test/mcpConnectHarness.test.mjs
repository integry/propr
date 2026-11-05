import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { resolveRoutingRevision, resolveSdkEvidence } from '../scripts/test-mcp-connect.mjs';

function sdkFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-sdk-resolution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const testFile = join(root, 'packages/api/test/integration.mjs');
  mkdirSync(dirname(testFile), { recursive: true });
  writeFileSync(testFile, '');
  return { root, testFile };
}

function installSdk(workspace, name, version) {
  const directory = join(workspace, 'node_modules/@modelcontextprotocol', name);
  const entryPoint = join(directory, 'dist/esm/index.js');
  mkdirSync(dirname(entryPoint), { recursive: true });
  // Import-only exports and unexported package.json, with a misleading main.
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: `@modelcontextprotocol/${name}`, version, type: 'module', main: './wrong.cjs',
    exports: { [name === 'sdk' ? './client/index.js' : '.']: { import: './dist/esm/index.js' } }
  }));
  writeFileSync(join(directory, 'dist/esm/package.json'), '{"type":"module"}');
  writeFileSync(entryPoint, 'throw new Error("Evidence resolution must not execute SDK code");');
  return { entryPoint, packageJson: join(directory, 'package.json') };
}

for (const layout of ['hoisted', 'nested', 'mixed']) {
  test(`SDK evidence resolves ${layout} dependencies from the API test context`, t => {
    const { root, testFile } = sdkFixture(t);
    const expected = {};
    const locations = {};
    for (const [index, name] of ['server', 'node', 'client', 'sdk'].entries()) {
      const version = `2.${index}.0`;
      const nested = layout === 'nested' || (layout === 'mixed' && name === 'client');
      if (nested) installSdk(root, name, '0.0.1'); // Must not report the shadowed root copy.
      locations[name] = installSdk(nested ? join(root, 'packages/api') : root, name, version);
      expected[name] = version;
    }
    const { sdkVersions, sdkProvenance } = resolveSdkEvidence(testFile);
    assert.deepEqual(sdkVersions, expected);
    for (const name of Object.keys(expected)) {
      assert.equal(sdkProvenance[name].entryPoint, locations[name].entryPoint);
      assert.equal(sdkProvenance[name].packageJson, locations[name].packageJson);
    }
  });
}

test('SDK evidence fails for a missing API dependency instead of using wrapper dependencies', t => {
  const { root, testFile } = sdkFixture(t);
  for (const name of ['server', 'node', 'sdk']) installSdk(root, name, '1.0.0');
  assert.throws(() => resolveSdkEvidence(testFile), error => {
    assert.match(error.message, /Cannot resolve SDK evidence for @modelcontextprotocol\/client/);
    assert.ok(error.message.includes(testFile));
    return true;
  });
});

test('SDK evidence fails if the resolved export target is missing', t => {
  const { root, testFile } = sdkFixture(t);
  const { entryPoint } = installSdk(root, 'server', '1.0.0');
  rmSync(entryPoint);
  assert.throws(() => resolveSdkEvidence(testFile), /Cannot resolve SDK evidence for @modelcontextprotocol\/server.*ENOENT/);
});

test('SDK evidence rejects matching metadata without a version', t => {
  const { root, testFile } = sdkFixture(t);
  installSdk(root, 'server', undefined);
  assert.throws(() => resolveSdkEvidence(testFile), /Cannot resolve SDK evidence.*Missing version/);
});

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
